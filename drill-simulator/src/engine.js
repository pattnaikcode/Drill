/*
 * OpsPilot Drill Simulator — simulation engine.
 *
 * Pure logic, no screen code. The same file runs in the browser and in Node tests.
 *
 * Three layers:
 *   1. Component TYPES (this file): how a kind of thing behaves, what it measures,
 *      how it can fail and how it can be fixed.
 *   2. A BLUEPRINT (YAML): which components a system has and how they connect.
 *   3. A DRILL (YAML, see session.js): which fault hits which component, and how
 *      the responder is scored.
 *
 * Every simulated tick, work flows along the blueprint's chain: the source produces
 * trades, each component takes what its capacity allows and passes it on. Faults only
 * change a component's rules (capacity, rejects, availability). Backlogs, lag, alerts
 * and missed cut-offs are not scripted — they follow from the flow.
 */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------- helpers
  function rng(seed) { // mulberry32: deterministic random numbers, so drills are repeatable
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const pad = n => String(n).padStart(2, '0');
  function parseClock(s) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
    if (!m) return null;
    return (+m[1]) * 3600 + (+m[2]) * 60;
  }
  function clockStr(t, withSeconds) {
    t = Math.max(0, Math.floor(t));
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    return pad(h) + ':' + pad(m) + (withSeconds ? ':' + pad(s) : '');
  }
  const fmtInt = n => Math.round(n).toLocaleString('en-IN');

  // ---------------------------------------------------------------- 1. component types
  const TYPES = {
    source: {
      label: 'Source', flow: true, required: ['rate_per_min'],
      metrics: { out_rate: 'Trades produced per minute' },
      faults: {}, actions: {},
    },
    kafka_topic: {
      label: 'Kafka topic', flow: true, required: ['partitions'],
      metrics: {
        lag: 'Total consumer lag (messages)', max_partition_lag: 'Largest single-partition lag',
        in_rate: 'Messages produced per minute', out_rate: 'Messages consumed per minute', rebalances: 'Consumer group rebalances',
      },
      faults: {
        poison_message: { label: 'Poison message blocking a partition', params: { partition: 3 } },
        rebalance_storm: { label: 'Consumer group rebalance storm', params: {} },
      },
      actions: {
        skip_poison_message: { label: 'Park stuck message to dead-letter topic', fixes: ['poison_message'] },
        tune_consumer_timeout: { label: 'Raise consumer session timeout and rejoin group', fixes: ['rebalance_storm'] },
      },
    },
    service: {
      label: 'Service', flow: true, required: ['capacity_per_min'],
      metrics: {
        in_rate: 'Trades received per minute', out_rate: 'Trades processed per minute', backlog: 'Trades waiting',
        reject_rate: 'Rejected (%)', error_rate: 'Errors and timeouts (%)', instances: 'Healthy instances',
        latency_ms: 'Processing time (ms)', rejected: 'Trades in exception queue',
      },
      faults: {
        instances_lost: { label: 'Instances lost (pods evicted)', params: { remaining: 2 } },
      },
      actions: {
        scale_out: { label: 'Scale out (reschedule instances on healthy nodes)', fixes: ['instances_lost'] },
        restart: { label: 'Rolling restart', fixes: [] },
        reprocess_rejected: { label: 'Reprocess exception queue', fixes: [] },
      },
    },
    external_party: {
      label: 'External party', flow: true, required: ['capacity_per_min'],
      metrics: { in_rate: 'Received per minute', out_rate: 'Completed per minute', backlog: 'Waiting / unmatched', error_rate: 'Failed calls (%)' },
      faults: {
        unavailable: { label: 'Vendor platform unavailable', params: {} },
      },
      actions: {
        escalate_to_vendor: { label: 'Raise P1 with vendor', fixes: ['unavailable'], delay_min: 8 },
        restart_adapter: { label: 'Restart our adapter', fixes: [] },
      },
    },
    ref_data: {
      label: 'Reference data', flow: false, required: ['refresh_every_min', 'stale_after_min'],
      metrics: { staleness_min: 'Minutes since last successful load' },
      faults: {
        feed_failed: { label: 'Upstream feed job failing', params: { last_refresh_minutes_ago: 18 } },
      },
      actions: {
        force_refresh: { label: 'Re-run feed from secondary source', fixes: ['feed_failed'] },
      },
    },
    database: {
      label: 'Database', flow: false, required: ['pool_size'],
      metrics: { pool_used: 'Connections in use', pool_pct: 'Pool used (%)', wait_ms: 'Connection wait (ms)' },
      faults: {
        pool_exhausted: { label: 'Connection pool exhausted by a long-running query', params: {} },
      },
      actions: {
        kill_blocking_session: { label: 'Kill blocking session', fixes: ['pool_exhausted'] },
      },
    },
  };

  // ---------------------------------------------------------------- 2. blueprint parsing + validation
  function parseBlueprint(text, yaml) {
    const errors = [];
    let bp;
    try { bp = yaml.load(text); } catch (e) { return { errors: ['YAML syntax: ' + (e.reason || e.message) + (e.mark ? ` (line ${e.mark.line + 1})` : '')] }; }
    if (!bp || typeof bp !== 'object') return { errors: ['The blueprint is empty.'] };
    return validateBlueprint(bp);
  }

  function validateBlueprint(bp) {
    const errors = [];
    const comps = Array.isArray(bp.components) ? bp.components : [];
    if (!bp.system) errors.push('Missing "system" (the system name).');
    if (!comps.length) errors.push('Missing "components" list.');
    const ids = new Map();
    comps.forEach((c, i) => {
      const where = `components[${i}]` + (c && c.id ? ` (${c.id})` : '');
      if (!c || typeof c !== 'object') { errors.push(`${where}: must be an object.`); return; }
      if (!c.id || !/^[a-z][a-z0-9_]*$/.test(c.id)) errors.push(`${where}: "id" must be lowercase letters, digits or _ and start with a letter.`);
      else if (ids.has(c.id)) errors.push(`${where}: duplicate id "${c.id}".`);
      else ids.set(c.id, c);
      const T = TYPES[c.type];
      if (!T) { errors.push(`${where}: unknown type "${c.type}". Known types: ${Object.keys(TYPES).join(', ')}.`); return; }
      T.required.forEach(k => {
        if (typeof c[k] !== 'number' || !(c[k] > 0)) errors.push(`${where}: "${k}" is required and must be a positive number for type ${c.type}.`);
      });
      if (c.type === 'kafka_topic' && c.partitions > 64) errors.push(`${where}: at most 64 partitions.`);
      if (c.type === 'service' && c.instances !== undefined && !(Number.isInteger(c.instances) && c.instances > 0)) errors.push(`${where}: "instances" must be a positive whole number.`);
      if (c.uses !== undefined && !Array.isArray(c.uses)) errors.push(`${where}: "uses" must be a list of component ids.`);
    });
    comps.forEach(c => (c && Array.isArray(c.uses) ? c.uses : []).forEach(u => {
      const d = ids.get(u);
      if (!d) errors.push(`${c.id}: uses unknown component "${u}".`);
      else if (TYPES[d.type] && TYPES[d.type].flow) errors.push(`${c.id}: can only "use" reference data or databases, not ${d.type} "${u}".`);
      else if (c.type !== 'service') errors.push(`${c.id}: only services can "use" other components.`);
    }));

    // flow chains: "a -> b -> c"
    const chains = [];
    const seen = new Set();
    (Array.isArray(bp.flow) ? bp.flow : []).forEach((line, i) => {
      const parts = String(line).split('->').map(s => s.trim()).filter(Boolean);
      if (parts.length < 2) { errors.push(`flow[${i}]: needs at least two components joined by "->".`); return; }
      const chain = [];
      parts.forEach((p, j) => {
        const c = ids.get(p);
        if (!c) { errors.push(`flow[${i}]: unknown component "${p}".`); return; }
        if (!TYPES[c.type] || !TYPES[c.type].flow) { errors.push(`flow[${i}]: ${c.type} "${p}" cannot be in the flow; attach it to a service with "uses".`); return; }
        if (seen.has(p)) { errors.push(`flow[${i}]: "${p}" appears more than once (only straight chains are supported in this version).`); return; }
        if (j === 0 && c.type !== 'source') errors.push(`flow[${i}]: a chain must start with a source, not ${c.type} "${p}".`);
        if (j > 0 && c.type === 'source') errors.push(`flow[${i}]: source "${p}" can only be first in a chain.`);
        if (c.type === 'kafka_topic' && j === parts.length - 1) errors.push(`flow[${i}]: Kafka topic "${p}" needs a consumer after it.`);
        if (c.type === 'kafka_topic' && j > 0 && ids.get(parts[j - 1]) && ids.get(parts[j - 1]).type === 'kafka_topic') errors.push(`flow[${i}]: two Kafka topics in a row need a service between them.`);
        seen.add(p); chain.push(p);
      });
      chains.push(chain);
    });
    if (!chains.length) errors.push('Missing "flow" (for example: - oms -> trades_topic -> tam).');
    comps.forEach(c => { if (c && TYPES[c.type] && TYPES[c.type].flow && c.id && !seen.has(c.id)) errors.push(`${c.id}: is not connected in any flow.`); });

    // clock + business
    const clock = bp.clock || {};
    const start = parseClock(clock.start || '13:30'), cutoff = parseClock(clock.cutoff || '15:00');
    if (start === null) errors.push('clock.start must look like "13:30".');
    if (cutoff === null) errors.push('clock.cutoff must look like "15:00".');
    if (start !== null && cutoff !== null && cutoff <= start + 600) errors.push('clock.cutoff must be at least 10 minutes after clock.start.');
    const biz = bp.business || {};
    const kpis = Array.isArray(biz.kpis) ? biz.kpis : [];
    kpis.forEach((k, i) => {
      if (!k || !k.label) errors.push(`business.kpis[${i}]: needs a "label".`);
      if (!k || !ids.has(k.at)) errors.push(`business.kpis[${i}]: "at" must be a component id.`);
    });
    if (kpis.filter(k => k && k.cutoff).length > 1) errors.push('Only one business KPI can be marked "cutoff: true".');

    // alert rules
    const alerts = Array.isArray(bp.alerts) ? bp.alerts : [];
    alerts.forEach((a, i) => {
      const where = `alerts[${i}]` + (a && a.name ? ` (${a.name})` : '');
      if (!a || !a.name) { errors.push(`${where}: needs a "name".`); return; }
      const c = ids.get(a.on);
      if (!c) { errors.push(`${where}: "on" must be a component id.`); return; }
      const T = TYPES[c.type];
      if (T && !T.metrics[a.metric]) errors.push(`${where}: ${c.type} has no metric "${a.metric}". Available: ${Object.keys(T.metrics).join(', ')}.`);
      if (typeof a.above !== 'number' && typeof a.below !== 'number') errors.push(`${where}: needs "above" or "below" as a number.`);
      if (a.severity && !/^P[1-4]$/.test(a.severity)) errors.push(`${where}: severity must be P1–P4.`);
    });

    if (errors.length) return { errors };
    const sourceRate = comps.filter(c => c.type === 'source').reduce((s, c) => s + c.rate_per_min, 0);
    const model = {
      id: bp.id || 'blueprint', system: bp.system, description: bp.description || '',
      start, cutoff, components: comps, byId: Object.fromEntries(comps.map(c => [c.id, c])), chains,
      alerts: alerts.map((a, i) => ({ id: 'rule' + i, severity: 'P3', ...a })),
      business: {
        currency: biz.currency || '₹', unit: biz.unit || 'Cr', avg_notional: typeof biz.avg_notional === 'number' ? biz.avg_notional : 0.5,
        produced_at: biz.produced_at || (comps.find(c => c.type === 'source') || {}).id,
        kpis, tolerance_trades: typeof biz.tolerance_trades === 'number' ? biz.tolerance_trades : sourceRate * 0.5,
      },
      raw: bp,
    };
    return { errors: [], blueprint: model };
  }

  // ---------------------------------------------------------------- 3. the simulator
  function Simulator(bp, opts) {
    opts = opts || {};
    this.bp = bp;
    this.rand = rng(opts.seed || 42);
    this.t = bp.start - 30 * 60;       // warm up for 30 simulated minutes
    this.alerts = []; this.alertSeq = 1000; this.events = [];
    this.history = { t: [] }; this.lastSample = -Infinity;
    this.c = {};
    bp.components.forEach(def => { this.c[def.id] = this._initState(def); });
    bp.chains.forEach(chain => chain.forEach((id, i) => {
      this.c[id].up = i > 0 ? chain[i - 1] : null;
      this.c[id].down = i < chain.length - 1 ? chain[i + 1] : null;
    }));
    this.ruleState = {};
    this.biz = { produced: 0, prevCut: 0, netRate: 0 };
    this.warmup(bp.start - this.t);
  }

  Simulator.prototype._initState = function (def) {
    const s = { def, type: def.type, fault: null, logs: [], hist: {}, rates: {}, tot: { in: 0, out: 0, rej: 0, err: 0 }, win: { in: 0, out: 0, rej: 0, err: 0, n: 0 } };
    if (def.type === 'kafka_topic') { s.parts = new Array(def.partitions).fill(0); s.blocked = -1; s.rebalances = 0; s.offsets = new Array(def.partitions).fill(0).map((_, i) => 884000 + i * 3121); s.dlq = 0; }
    if (def.type === 'service') { s.inbox = 0; s.retry = 0; s.rejected = 0; s.configured = def.instances || 4; s.instances = s.configured; s.restartUntil = -1; }
    if (def.type === 'external_party') { s.inbox = 0; s.recoverAt = -1; s.adapterDownUntil = -1; }
    if (def.type === 'ref_data') { s.lastRefresh = this.t; s.records = 48210; }
    if (def.type === 'database') { s.used = Math.round(def.pool_size * 0.28); }
    return s;
  };

  Simulator.prototype.now = function () { return this.t; };
  Simulator.prototype.time = function (sec) { return clockStr(this.t, sec); };

  Simulator.prototype.log = function (id, level, msg) {
    const s = this.c[id];
    s.logs.push({ t: this.t, level, msg, line: `${clockStr(this.t, true)} ${level.padEnd(5)} [${id}] ${msg}` });
    if (s.logs.length > 400) s.logs.splice(0, s.logs.length - 400);
  };
  Simulator.prototype.chance = function (p) { return this.rand() < p; };

  // capacity of a service after faults and dependencies are applied
  Simulator.prototype.serviceFactor = function (s) {
    let f = s.instances / s.configured;
    if (this.t < s.restartUntil) f *= 0.5;
    (s.def.uses || []).forEach(u => { const d = this.c[u]; if (d.type === 'database' && d.fault && d.fault.type === 'pool_exhausted') f *= 0.2; });
    const up = s.up && this.c[s.up];
    if (up && up.type === 'kafka_topic' && up.fault && up.fault.type === 'rebalance_storm') f *= 0.35;
    return f;
  };
  Simulator.prototype.staleRefs = function (s) {
    return (s.def.uses || []).map(u => this.c[u]).filter(d => d.type === 'ref_data' && this.staleness(d) > d.def.stale_after_min);
  };
  Simulator.prototype.staleness = function (d) { return (this.t - d.lastRefresh) / 60; };

  Simulator.prototype.accept = function (id, n) {
    const s = this.c[id];
    s.tot.in += n; s.win.in += n;
    if (s.type === 'kafka_topic') {
      const per = n / s.parts.length;
      for (let i = 0; i < s.parts.length; i++) { s.parts[i] += per; s.offsets[i] += per; }
    } else if (s.type === 'service' || s.type === 'external_party') s.inbox += n;
  };

  Simulator.prototype.step = function (dt) {
    const bp = this.bp;
    this.t += dt;
    // reference data refresh schedule
    Object.values(this.c).filter(s => s.type === 'ref_data').forEach(s => {
      const due = this.t - s.lastRefresh >= s.def.refresh_every_min * 60;
      if (!due) return;
      if (s.fault && s.fault.type === 'feed_failed') {
        if (!s.lastFailLog || this.t - s.lastFailLog >= 300) {
          s.lastFailLog = this.t;
          this.log(s.def.id, 'ERROR', `${s.def.name} feed job FAILED: sftp://feeds.vendor.example:22 connection refused (attempt ${Math.floor((this.t - s.fault.since) / 300) + 1})`);
        }
      } else {
        s.lastRefresh = this.t; s.records += Math.floor(this.rand() * 40);
        this.log(s.def.id, 'INFO', `${s.def.name} loaded: ${fmtInt(s.records)} records`);
      }
    });
    // databases
    Object.values(this.c).filter(s => s.type === 'database').forEach(s => {
      const P = s.def.pool_size;
      if (s.fault && s.fault.type === 'pool_exhausted') s.used = P;
      else s.used = Math.max(2, Math.min(P, Math.round(P * (0.24 + this.rand() * 0.1))));
    });
    // work flows along each chain
    bp.chains.forEach(chain => chain.forEach(id => this._process(id, dt)));
    // vendor recovery after escalation
    Object.values(this.c).forEach(s => {
      if (s.type === 'external_party' && s.recoverAt > 0 && this.t >= s.recoverAt) {
        s.recoverAt = -1; this.clearFault(s.def.id, 'Vendor reports platform restored');
        this.log(s.def.id, 'INFO', `${s.def.name} responding normally again (vendor incident closed)`);
      }
    });
    this._chatter(dt);
    this._rates(dt);
    this._business(dt);
    this._evalAlerts();
    if (this.t - this.lastSample >= 60) { this.lastSample = this.t; this._sample(); }
  };

  Simulator.prototype._process = function (id, dt) {
    const s = this.c[id], def = s.def, min = dt / 60;
    if (s.type === 'source') {
      const n = def.rate_per_min * min * (0.94 + this.rand() * 0.12);
      this.biz.produced += n; s.tot.out += n; s.win.out += n;
      if (s.down) this.accept(s.down, n);
      return;
    }
    if (s.type === 'kafka_topic') return; // the consumer pulls from the topic
    if (s.type === 'service') {
      const up = s.up && this.c[s.up];
      const fromKafka = up && up.type === 'kafka_topic';
      let cap = def.capacity_per_min * this.serviceFactor(s) * min;
      const take = [];
      // retries from the exception queue are processed first
      const r = Math.min(s.retry, cap); s.retry -= r; cap -= r; take.push(r);
      let got = r;
      if (fromKafka) {
        // equal share per partition; a blocked partition gives nothing
        const open = up.parts.map((v, i) => i === up.blocked ? 0 : v);
        let remaining = cap;
        for (let pass = 0; pass < 3 && remaining > 1e-9; pass++) {
          const active = open.map((v, i) => [v, i]).filter(([v]) => v > 1e-9);
          if (!active.length) break;
          const share = remaining / active.length;
          active.forEach(([v, i]) => { const x = Math.min(v, share); open[i] -= x; up.parts[i] -= x; remaining -= x; got += x; });
        }
        const used = got - r; up.tot.out += used; up.win.out += used;
      } else {
        const x = Math.min(s.inbox, cap); s.inbox -= x; got += x;
      }
      const stale = this.staleRefs(s).length > 0;
      const rejFrac = stale ? 0.08 : 0;
      const rej = got * rejFrac;
      s.rejected += rej; s.tot.rej += rej; s.win.rej += rej;
      const ok = got - rej;
      s.tot.out += ok; s.win.out += ok;
      const dbBad = (def.uses || []).some(u => this.c[u].fault && this.c[u].fault.type === 'pool_exhausted');
      const errs = dbBad ? got * 0.06 + 0.5 : 0; s.win.err += errs;
      if (s.down) this.accept(s.down, ok);
      return;
    }
    if (s.type === 'external_party') {
      const unavailable = (s.fault && s.fault.type === 'unavailable') || this.t < s.adapterDownUntil;
      const cap = unavailable ? 0 : def.capacity_per_min * min;
      const x = Math.min(s.inbox, cap); s.inbox -= x;
      s.tot.out += x; s.win.out += x;
      if (unavailable) s.win.err += Math.max(1, s.inbox > 0 ? 3 : 1);
      if (s.down) this.accept(s.down, x);
    }
  };

  // realistic log lines, driven by the current state (never by the drill script)
  Simulator.prototype._chatter = function (dt) {
    const p = dt / 30; // ~one routine line per component every 30 simulated seconds
    Object.values(this.c).forEach(s => {
      const id = s.def.id, name = s.def.name, f = s.fault && s.fault.type;
      if (s.type === 'source' && this.chance(p)) {
        const tgt = s.down ? this.c[s.down].def.name : 'downstream';
        this.log(id, 'INFO', `Published ${Math.round(this.rates(id).out_rate / 2)} fills to ${tgt} (batch ${88000 + Math.floor(this.t / 30)})`);
      }
      if (s.type === 'kafka_topic') {
        if (s.blocked >= 0 && this.chance(p * 0.6)) this.log(id, 'WARN', `Consumer offset for ${name}-${s.blocked} not advancing at ${Math.floor(s.stuckOffset)} (lag ${fmtInt(s.parts[s.blocked])})`);
        if (f === 'rebalance_storm' && this.chance(p * 1.4)) { s.rebalances++; this.log(id, 'WARN', `Group ${s.def.consumer_group || 'consumers'} rebalancing (generation ${400 + s.rebalances}): member left, session timeout 10000ms`); }
        if (!f && this.chance(p * 0.3)) this.log(id, 'INFO', `Group ${s.def.consumer_group || 'consumers'} stable: ${this._consumerCount(s)} members, ${s.parts.length} partitions`);
      }
      if (s.type === 'service') {
        const up = s.up && this.c[s.up];
        if (up && up.type === 'kafka_topic' && up.blocked >= 0 && this.chance(p * 1.5))
          this.log(id, 'ERROR', `Failed to deserialize record ${up.def.name}-${up.blocked}@${Math.floor(up.stuckOffset)}: Unrecognized field "allocRatioV2" (class TradeEvent) — retrying`);
        if (up && up.type === 'kafka_topic' && up.fault && up.fault.type === 'rebalance_storm' && this.chance(p))
          this.log(id, 'WARN', `Partitions revoked [${[0, 1, 2].join(', ')}]; rejoining group ${up.def.consumer_group || ''}`.trim());
        if (f === 'instances_lost' && this.chance(p * 0.8))
          this.log(id, 'WARN', `Only ${s.instances}/${s.configured} ${name} instances ready; pods ${id}-${s.instances + 1}, ${id}-${s.configured} Pending (node memory pressure)`);
        if ((s.def.uses || []).some(u => this.c[u].fault && this.c[u].fault.type === 'pool_exhausted') && this.chance(p * 1.6))
          this.log(id, 'ERROR', `HikariPool-1 - Connection is not available, request timed out after 30000ms (block BLK-${71000 + Math.floor(this.rand() * 900)})`);
        this.staleRefs(s).forEach(r => { if (this.chance(p * 1.4)) this.log(id, 'ERROR', `Allocation rejected for block BLK-${71000 + Math.floor(this.rand() * 900)}: no SSI for account ACC-${48000 + Math.floor(this.rand() * 900)} in ${r.def.name}`); });
        if (this.t < s.restartUntil && this.chance(p)) this.log(id, 'INFO', `Rolling restart in progress: instance ${1 + Math.floor(this.rand() * s.configured)}/${s.configured} restarting`);
        if (this.chance(p * 0.7)) {
          const r = this.rates(id);
          this.log(id, 'INFO', `Processed ${Math.round(r.out_rate / 2)} trades in last 30s (backlog ${fmtInt(this.metric(id, 'backlog'))})`);
        }
      }
      if (s.type === 'external_party') {
        if ((f === 'unavailable' || this.t < s.adapterDownUntil) && this.chance(p * 1.6)) this.log(id, 'ERROR', `${name} API POST /v1/messages returned 503 Service Unavailable (retry ${1 + Math.floor(this.rand() * 5)}/5)`);
        else if (!f && this.chance(p * 0.6)) this.log(id, 'INFO', `${name}: ${Math.round(this.rates(id).out_rate / 2)} messages acknowledged in last 30s`);
      }
      if (s.type === 'database') {
        if (f === 'pool_exhausted' && this.chance(p)) this.log(id, 'WARN', `Session 482 (month_end_recon_report) running ${Math.round((this.t - s.fault.since) / 60) + 14} min, holding ${s.def.pool_size - 4} connections`);
        else if (this.chance(p * 0.25)) this.log(id, 'INFO', `Pool active ${s.used}/${s.def.pool_size}, idle ${s.def.pool_size - s.used}`);
      }
    });
  };
  Simulator.prototype._consumerCount = function (k) {
    const svc = k.down && this.c[k.down];
    return svc && svc.type === 'service' ? svc.instances : 1;
  };

  Simulator.prototype._rates = function (dt) {
    Object.values(this.c).forEach(s => {
      const w = s.win; w.n += dt;
      if (w.n < 30) return; // rates over a rolling 30-second window
      const k = 60 / w.n, a = 0.5;
      const prev = s.rates;
      const nr = { in_rate: w.in * k, out_rate: w.out * k, rej_rate: w.rej * k, err_rate: w.err * k };
      s.rates = prev.n ? Object.fromEntries(Object.keys(nr).map(x => [x, prev[x] * (1 - a) + nr[x] * a])) : nr;
      s.rates.n = 1;
      s.win = { in: 0, out: 0, rej: 0, err: 0, n: 0 };
    });
  };
  Simulator.prototype.rates = function (id) { const r = this.c[id].rates; return r.n ? r : { in_rate: 0, out_rate: 0, rej_rate: 0, err_rate: 0 }; };

  Simulator.prototype.metric = function (id, m) {
    const s = this.c[id], r = this.rates(id);
    switch (s.type) {
      case 'source': return m === 'out_rate' ? r.out_rate : 0;
      case 'kafka_topic':
        if (m === 'lag') return s.parts.reduce((a, b) => a + b, 0);
        if (m === 'max_partition_lag') return Math.max(...s.parts);
        if (m === 'in_rate') return r.in_rate;
        if (m === 'out_rate') return r.out_rate;
        if (m === 'rebalances') return s.rebalances;
        return 0;
      case 'service': {
        const up = s.up && this.c[s.up];
        const backlog = (up && up.type === 'kafka_topic' ? 0 : s.inbox) + s.retry;
        const processed = r.out_rate + r.rej_rate;
        if (m === 'backlog') return backlog;
        if (m === 'in_rate') return up && up.type === 'kafka_topic' ? r.out_rate + r.rej_rate : r.in_rate;
        if (m === 'out_rate') return r.out_rate;
        if (m === 'reject_rate') return processed > 1 ? 100 * r.rej_rate / processed : 0;
        if (m === 'error_rate') return processed > 1 ? Math.min(100, 100 * r.err_rate / processed) : (r.err_rate > 0 ? 100 : 0);
        if (m === 'instances') return s.instances;
        if (m === 'rejected') return s.rejected;
        if (m === 'latency_ms') { const f = this.serviceFactor(s); return Math.round(140 / Math.max(f, 0.05) * (0.95 + this.rand() * 0.1)); }
        return 0;
      }
      case 'external_party':
        if (m === 'backlog') return s.inbox;
        if (m === 'in_rate') return r.in_rate;
        if (m === 'out_rate') return r.out_rate;
        if (m === 'error_rate') return (s.fault && s.fault.type === 'unavailable') || this.t < s.adapterDownUntil ? 100 : 0;
        return 0;
      case 'ref_data': return m === 'staleness_min' ? this.staleness(s) : 0;
      case 'database':
        if (m === 'pool_used') return s.used;
        if (m === 'pool_pct') return 100 * s.used / s.def.pool_size;
        if (m === 'wait_ms') return s.fault && s.fault.type === 'pool_exhausted' ? 30000 : 2 + Math.round(this.rand() * 6);
        return 0;
    }
    return 0;
  };

  // business KPIs: trades produced but not yet past a stage
  Simulator.prototype.kpi = function (k) {
    const s = this.c[k.at];
    const passed = s.type === 'source' ? s.tot.out : s.tot.out;
    const trades = Math.max(0, this.biz.produced - passed);
    return { label: k.label, trades, notional: trades * this.bp.business.avg_notional, cutoff: !!k.cutoff };
  };
  Simulator.prototype.kpis = function () { return this.bp.business.kpis.map(k => this.kpi(k)); };
  Simulator.prototype.cutoffKpi = function () { const k = this.bp.business.kpis.find(x => x.cutoff); return k ? this.kpi(k) : null; };
  Simulator.prototype._business = function (dt) {
    const k = this.cutoffKpi(); if (!k) return;
    const net = (k.trades - this.biz.prevCut) / (dt / 60);
    this.biz.prevCut = k.trades;
    this.biz.netRate = this.biz.netRate * 0.9 + net * 0.1;
  };
  // will the cut-off KPI be back to normal before the cut-off?
  Simulator.prototype.cutoffRisk = function () {
    const k = this.cutoffKpi(); if (!k) return { atRisk: false };
    const tol = this.bp.business.tolerance_trades, left = (this.bp.cutoff - this.t) / 60;
    if (k.trades <= tol) return { atRisk: false, eta: null };
    if (this.biz.netRate >= -1) return { atRisk: true, eta: null };
    const eta = (k.trades - tol) / -this.biz.netRate;
    return { atRisk: eta > left, eta };
  };

  Simulator.prototype._evalAlerts = function () {
    if (this.t < this.bp.start) return; // no paging during warm-up
    const rules = this.bp.alerts.slice();
    const k = this.cutoffKpi();
    if (k) rules.push({ id: 'cutoff', name: `${k.label} — cut-off at risk`, on: this.bp.business.kpis.find(x => x.cutoff).at, severity: 'P1', builtin: true });
    rules.forEach(rule => {
      let val, firing;
      if (rule.builtin) { val = k.trades; firing = this.cutoffRisk().atRisk && this.t < this.bp.cutoff; }
      else {
        val = this.metric(rule.on, rule.metric);
        firing = typeof rule.above === 'number' ? val > rule.above : val < rule.below;
      }
      const st = this.ruleState[rule.id] || (this.ruleState[rule.id] = { since: null, clearSince: null, alert: null });
      if (firing) {
        st.clearSince = null;
        if (st.since === null) st.since = this.t;
        if (!st.alert && this.t - st.since >= 60) { // sustained for 1 simulated minute
          const a = { id: 'ALRT-' + (++this.alertSeq), rule: rule.id, name: rule.name, severity: rule.severity || 'P3', on: rule.on, metric: rule.metric || 'business', threshold: rule.builtin ? 'projected past cut-off' : (typeof rule.above === 'number' ? '> ' + rule.above : '< ' + rule.below), value: val, firedAt: this.t, resolvedAt: null, status: 'FIRING' };
          st.alert = a; this.alerts.unshift(a);
          this.events.push({ t: this.t, kind: 'alert', text: `${a.id} ${a.severity} ${a.name} fired` });
        }
        if (st.alert) st.alert.value = val;
      } else {
        st.since = null;
        if (st.alert) {
          if (st.clearSince === null) st.clearSince = this.t;
          if (this.t - st.clearSince >= 120) { // clear for 2 minutes before resolving
            st.alert.status = 'RESOLVED'; st.alert.resolvedAt = this.t;
            this.events.push({ t: this.t, kind: 'alert', text: `${st.alert.id} ${st.alert.name} resolved` });
            st.alert = null;
          }
        }
      }
    });
  };
  Simulator.prototype.addExternalAlert = function (a) { // e.g. unrelated noise in a drill
    const al = { id: 'ALRT-' + (++this.alertSeq), firedAt: this.t, resolvedAt: null, status: 'FIRING', severity: 'P4', metric: 'external', value: '', threshold: '', ...a };
    this.alerts.unshift(al); return al;
  };

  Simulator.prototype._sample = function () {
    this.history.t.push(this.t);
    Object.values(this.c).forEach(s => {
      Object.keys(TYPES[s.type].metrics).forEach(m => {
        const h = s.hist[m] || (s.hist[m] = []);
        h.push(this.metric(s.def.id, m));
      });
    });
    const k = this.cutoffKpi();
    (this.history.cut || (this.history.cut = [])).push(k ? k.notional : 0);
    if (this.history.t.length > 240) {
      this.history.t.shift(); this.history.cut.shift();
      Object.values(this.c).forEach(s => Object.values(s.hist).forEach(h => h.shift()));
    }
  };

  Simulator.prototype.warmup = function (secs) { const step = 5; for (let x = 0; x < secs; x += step) this.step(step); };

  Simulator.prototype.health = function (id) {
    const s = this.c[id], m = k => this.metric(id, k);
    const rate = this.bp.components.filter(c => c.type === 'source').reduce((a, c) => a + c.rate_per_min, 0) || 1;
    switch (s.type) {
      case 'source': return 'ok';
      case 'kafka_topic': { const L = m('lag'), P = m('max_partition_lag'); return L > rate * 8 || P > rate * 2 ? 'bad' : L > rate * 2 || P > rate * 0.8 ? 'warn' : 'ok'; }
      case 'service': {
        if (s.instances < s.configured || m('error_rate') > 2 || m('reject_rate') > 5) return m('reject_rate') > 5 || this.serviceFactor(s) < 0.3 ? 'bad' : 'warn';
        if (m('reject_rate') > 1 || s.rejected > 5 || m('backlog') > rate * 2) return 'warn';
        return 'ok';
      }
      case 'external_party': return m('error_rate') > 50 ? 'bad' : m('backlog') > rate * 2 ? 'warn' : 'ok';
      case 'ref_data': { const st = m('staleness_min'); return st > s.def.stale_after_min * 1.5 ? 'bad' : st > s.def.stale_after_min ? 'warn' : 'ok'; }
      case 'database': { const p = m('pool_pct'); return p > 95 ? 'bad' : p > 85 ? 'warn' : 'ok'; }
    }
    return 'ok';
  };

  // ---------------------------------------------------------------- faults and actions
  Simulator.prototype.injectFault = function (id, type, params) {
    const s = this.c[id];
    if (!s) throw new Error(`No component "${id}"`);
    const F = TYPES[s.type].faults[type];
    if (!F) throw new Error(`${s.type} "${id}" has no fault "${type}"`);
    const p = { ...F.params, ...(params || {}) };
    s.fault = { type, params: p, since: this.t };
    if (type === 'poison_message') { s.blocked = Math.min(s.parts.length - 1, Math.max(0, p.partition | 0)); s.stuckOffset = s.offsets[s.blocked] - s.parts[s.blocked]; }
    if (type === 'instances_lost') s.instances = Math.max(1, Math.min(s.configured - 1, p.remaining | 0));
    if (type === 'feed_failed') s.lastRefresh = Math.min(s.lastRefresh, this.t - p.last_refresh_minutes_ago * 60);
    if (type === 'pool_exhausted') this.log(id, 'WARN', `Long-running query started: session 482 (month_end_recon_report), full table scan on ALLOCATION_HIST`);
    this.events.push({ t: this.t, kind: 'fault', hidden: true, text: `Fault injected: ${F.label} on ${s.def.name}` });
    return s.fault;
  };
  Simulator.prototype.clearFault = function (id, why) {
    const s = this.c[id]; if (!s.fault) return;
    this.events.push({ t: this.t, kind: 'fixed', text: `${s.def.name}: ${why}` });
    if (s.type === 'kafka_topic') s.blocked = -1;
    s.fault = null;
  };
  Simulator.prototype.actionsFor = function (id) {
    const s = this.c[id]; return s ? TYPES[s.type].actions : {};
  };
  Simulator.prototype.applyAction = function (id, action) {
    const s = this.c[id];
    if (!s) return { ok: false, message: `No component "${id}"` };
    const A = TYPES[s.type].actions[action];
    if (!A) return { ok: false, message: `${s.def.name} has no action "${action}"` };
    const f = s.fault && s.fault.type, name = s.def.name;
    let message, effect = 'none';
    switch (action) {
      case 'skip_poison_message':
        if (f === 'poison_message') { s.dlq++; message = `Parked ${name}-${s.blocked}@${Math.floor(s.stuckOffset)} to ${name}.DLQ; partition ${s.blocked} consuming again. 1 trade needs manual repair.`; this.log(id, 'INFO', `Offset ${Math.floor(s.stuckOffset)} on partition ${s.blocked} skipped and parked to DLQ`); this.clearFault(id, 'stuck message parked to DLQ'); effect = 'fixed'; }
        else message = 'No stuck offset found on any partition. Nothing parked.';
        break;
      case 'tune_consumer_timeout':
        if (f === 'rebalance_storm') { message = 'session.timeout.ms raised to 45000; group rejoined and stable.'; this.clearFault(id, 'consumer session timeout raised'); effect = 'fixed'; }
        else { message = 'Consumer group restarted with new timeout; brief pause while it rejoined.'; s.rebalances++; }
        break;
      case 'scale_out':
        if (f === 'instances_lost') { s.instances = s.configured; s.configured += 1; s.instances = s.configured; message = `Rescheduled on healthy nodes; ${s.instances}/${s.configured} instances ready.`; this.clearFault(id, 'instances rescheduled'); effect = 'fixed'; }
        else { s.configured += 1; s.instances += 1; message = `Added one instance (${s.instances}/${s.configured} ready). No change to the underlying problem.`; }
        this.log(id, 'INFO', message);
        break;
      case 'restart':
        s.restartUntil = this.t + 180;
        message = 'Rolling restart started: capacity halved for about 3 minutes.' + (f === 'instances_lost' ? ' Evicted pods are still Pending — the nodes are the problem, not the process.' : '');
        this.log(id, 'INFO', 'Rolling restart requested');
        break;
      case 'reprocess_rejected': {
        const n = Math.round(s.rejected);
        if (!n) { message = 'Exception queue is empty.'; break; }
        if (this.staleRefs(s).length) { message = `Resubmitted ${fmtInt(n)} trades — they will be rejected again while SSI data is stale.`; }
        else message = `Resubmitted ${fmtInt(n)} trades from the exception queue.`;
        s.retry += s.rejected; s.rejected = 0; effect = this.staleRefs(s).length ? 'none' : 'partial';
        break;
      }
      case 'escalate_to_vendor':
        if (f === 'unavailable') { s.recoverAt = this.t + (A.delay_min || 8) * 60; message = `Vendor P1 raised. Vendor confirms an outage on their side; ETA about ${A.delay_min || 8} minutes.`; effect = 'pending'; }
        else message = 'Vendor reports no issues on their platform.';
        break;
      case 'restart_adapter':
        s.adapterDownUntil = this.t + 60;
        message = 'Adapter restarted (1 minute without connectivity).' + (f === 'unavailable' ? ' Calls still fail: the vendor platform itself is down.' : '');
        break;
      case 'force_refresh':
        s.lastRefresh = this.t; s.records += 12;
        if (f === 'feed_failed') { message = `Loaded ${fmtInt(s.records)} records from the secondary source. Rejections should stop; trades already rejected need reprocessing.`; this.clearFault(id, 'feed re-run from secondary source'); effect = 'fixed'; }
        else message = `Refreshed: ${fmtInt(s.records)} records (no change).`;
        this.log(id, 'INFO', `${name} loaded: ${fmtInt(s.records)} records (manual refresh)`);
        break;
      case 'kill_blocking_session':
        if (f === 'pool_exhausted') { message = 'Killed session 482 (month_end_recon_report). Connections released.'; this.log(id, 'INFO', 'Session 482 killed by operator; pool recovering'); this.clearFault(id, 'blocking session killed'); effect = 'fixed'; }
        else message = 'No blocking sessions found.';
        break;
    }
    this.events.push({ t: this.t, kind: 'action', text: `${A.label} on ${name}: ${message}` });
    return { ok: true, message, effect, label: A.label };
  };

  Simulator.prototype.activeFaults = function () {
    return Object.values(this.c).filter(s => s.fault).map(s => ({ id: s.def.id, type: s.fault.type }));
  };
  Simulator.prototype.pendingRepair = function () { // work a responder still has to clear up
    let rejected = 0;
    Object.values(this.c).forEach(s => { if (s.type === 'service') rejected += s.rejected; });
    return { rejected };
  };

  const OpsSim = { TYPES, parseBlueprint, validateBlueprint, Simulator, clockStr, parseClock, fmtInt, rng };
  if (typeof module === 'object' && module.exports) module.exports = OpsSim;
  else root.OpsSim = OpsSim;
})(typeof globalThis !== 'undefined' ? globalThis : this);
