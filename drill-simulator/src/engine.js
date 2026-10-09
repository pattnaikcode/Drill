/*
 * OpsPilot Drill Simulator — simulation engine.
 *
 * Pure logic, no screen code. The same file runs in the browser and in Node tests.
 *
 * Layers:
 *   1. Component TYPES: how a kind of thing behaves, what it measures, how it can fail.
 *   2. HOSTS: services, databases, adapters and loaders run on hosts, and hosts fail too
 *      (disk full, out of memory, runaway CPU, open files, clock drift, expired certificates).
 *      A host fault shows up as an application symptom one layer up: nested failures.
 *   3. ACTIONS: one runbook catalogue per kind of component. It contains fixes, heavy-handed
 *      options and harmful ones; nothing tells the responder which is which.
 *   4. A BLUEPRINT (YAML): which components a system has and how they connect (a flow graph).
 *   5. A DRILL / use case (YAML, see session.js): which fault hits where, and how it is scored.
 *
 * Every simulated tick, work flows through the graph in dependency order. Faults only change
 * one component's (or host's) rules. Backlogs, lag, alerts and missed cut-offs follow from the flow.
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
  const hash = s => [...String(s)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);

  // ---------------------------------------------------------------- 1. component types
  const HOST_METRICS = { host_cpu_pct: 'Host CPU (%)', host_mem_pct: 'Host memory (%)', host_disk_pct: 'Host disk, busiest mount (%)' };
  const TYPES = {
    source: {
      label: 'Participant', flow: true, required: ['rate_per_min'],
      metrics: { out_rate: 'Orders/trades sent per minute', held: 'Waiting at participant (not delivered)' },
      faults: {
        session_down: { label: 'Session rejected: sequence number mismatch', params: {} },
        order_flood: { label: 'Message flood from the participant', params: { multiplier: 4 } },
      },
    },
    kafka_topic: {
      label: 'Kafka topic', flow: true, required: ['partitions'],
      metrics: { lag: 'Total consumer lag (messages)', max_partition_lag: 'Largest single-partition lag', in_rate: 'Messages produced per minute', out_rate: 'Messages consumed per minute', rebalances: 'Consumer group rebalances' },
      faults: {
        poison_message: { label: 'Poison message blocking a partition', params: { partition: 3 } },
        rebalance_storm: { label: 'Consumer group rebalance storm', params: {} },
      },
    },
    service: {
      label: 'Service', flow: true, required: ['capacity_per_min'],
      metrics: {
        in_rate: 'Received per minute', out_rate: 'Processed per minute', backlog: 'Waiting in queue',
        reject_rate: 'Rejected (%)', error_rate: 'Errors and timeouts (%)', instances: 'Healthy instances',
        latency_ms: 'Processing time (ms)', rejected: 'In exception queue', sessions_down: 'Participant sessions down', ...HOST_METRICS,
      },
      faults: {
        instances_lost: { label: 'Instances lost (pods evicted)', params: { remaining: 2 } },
        config_change: { label: 'Bad configuration change', params: { api: 'limits-api', timeout_ms: 50 } },
      },
    },
    external_party: {
      label: 'External party', flow: true, required: ['capacity_per_min'],
      metrics: { in_rate: 'Received per minute', out_rate: 'Completed per minute', backlog: 'Waiting / unmatched', error_rate: 'Failed calls (%)', ...HOST_METRICS },
      faults: {
        unavailable: { label: 'External platform down (their side)', params: {} },
        api_rate_limited: { label: 'API rate limit exceeded (HTTP 429)', params: { quota_per_min: 600 } },
        api_auth_expired: { label: 'API credentials expired (HTTP 401)', params: {} },
      },
    },
    ref_data: {
      label: 'Reference data', flow: false, required: ['refresh_every_min', 'stale_after_min'],
      metrics: { staleness_min: 'Minutes since last successful load', ...HOST_METRICS },
      faults: { feed_failed: { label: 'Upstream feed job failing', params: { last_refresh_minutes_ago: 18 } } },
    },
    database: {
      label: 'Database', flow: false, required: ['pool_size'],
      metrics: { pool_used: 'Connections in use', pool_pct: 'Pool used (%)', wait_ms: 'Connection wait (ms)', ...HOST_METRICS },
      faults: { pool_exhausted: { label: 'Connection pool exhausted by a long-running query', params: {} } },
    },
    issuer: {
      label: 'Issuer', flow: false, required: [],
      metrics: { pending_announcements: 'Announcements not yet applied' },
      faults: { announcement_missed: { label: 'Corporate action not applied', params: { reject_share: 0.06 } } },
    },
  };

  // ---------------------------------------------------------------- 2. hosts and host faults
  // In the simulator the adapter host of an external party is OURS (our side of the connection).
  const HOST_TYPES = ['service', 'database', 'external_party', 'ref_data'];
  const MOUNT = { service: '/var/log', database: '/u01/arch', external_party: '/var/spool/adapter', ref_data: '/data/feeds' };
  const HOST_FAULTS = {
    disk_full: { label: 'Disk full on the host', types: HOST_TYPES, params: {} },
    memory_oom: { label: 'Out of memory: process killed and crash-looping', types: ['service'], params: {} },
    cpu_runaway: { label: 'CPU saturated by another process on the host', types: ['service', 'database'], params: {} },
    fd_exhausted: { label: 'Too many open files (file descriptor limit)', types: ['service', 'external_party'], params: {} },
    clock_skew: { label: 'Host clock drift (NTP stopped)', types: ['service'], params: { seconds: 94 } },
    cert_expired: { label: 'TLS client certificate expired', types: ['external_party'], params: {} },
  };
  const hasHost = type => HOST_TYPES.includes(type);
  // databases default to Oracle; "engine: postgres" changes error messages, mounts and SQL views
  const isPg = s => !!(s && s.def && s.def.engine === 'postgres');
  const mountOf = s => isPg(s) ? '/var/lib/pgsql/data' : MOUNT[s.type];
  function faultsFor(type) { // every fault a component of this type can have, application and host
    const out = { ...(TYPES[type] ? TYPES[type].faults : {}) };
    Object.entries(HOST_FAULTS).forEach(([k, f]) => { if (f.types.includes(type)) out[k] = { ...f, host: true }; });
    return out;
  }

  // ---------------------------------------------------------------- 3. runbook action catalogue
  // Shown for every component of a type. Fixes, heavy-handed options and harmful ones sit side by side.
  const SVC = ['service'], EXT = ['external_party'], DB = ['database'], REF = ['ref_data'], SRC = ['source'], KAF = ['kafka_topic'], ISS = ['issuer'];
  const ACTIONS = {
    restart: { label: 'Rolling restart of the application', types: SVC },
    scale_out: { label: 'Scale out / reschedule instances', types: SVC, fixes: ['instances_lost'] },
    rollback_deployment: { label: 'Roll back the last deployment', types: SVC },
    revert_config: { label: 'Revert the last configuration change', types: SVC, fixes: ['config_change'] },
    reprocess_rejected: { label: 'Reprocess the exception queue', types: SVC },
    increase_memory_limit: { label: 'Increase memory limit and redeploy', types: SVC, fixes: ['memory_oom'] },
    raise_fd_limit: { label: 'Raise open-files limit and restart', types: [...SVC, ...EXT], fixes: ['fd_exhausted'] },
    purge_queue: { label: 'Purge the queue (drop waiting messages)', types: [...SVC, ...KAF, ...EXT] },
    clear_disk_space: { label: 'Archive and clear old files on the host', types: HOST_TYPES, fixes: ['disk_full'] },
    kill_runaway_process: { label: 'Kill the runaway process on the host', types: ['service', 'database'], fixes: ['cpu_runaway'] },
    resync_ntp: { label: 'Restart NTP and resync the host clock', types: HOST_TYPES, fixes: ['clock_skew'] },
    restart_host: { label: 'Reboot the host', types: HOST_TYPES, fixes: ['clock_skew', 'cpu_runaway'] },
    failover_to_dr: { label: 'Fail over to the DR site', types: ['service', 'database', 'external_party'], fixes: ['disk_full', 'memory_oom', 'cpu_runaway', 'fd_exhausted', 'clock_skew'] },
    renew_certificate: { label: 'Install the renewed TLS certificate', types: EXT, fixes: ['cert_expired'] },
    escalate_to_vendor: { label: 'Raise a P1 with the external party', types: EXT, fixes: ['unavailable'], delay_min: 8 },
    restart_adapter: { label: 'Restart our adapter', types: EXT },
    enable_retry_backoff: { label: 'Switch API retries to exponential back-off', types: EXT, fixes: ['api_rate_limited'] },
    rotate_api_credentials: { label: 'Rotate the API client secret from the vault', types: EXT, fixes: ['api_auth_expired'] },
    skip_poison_message: { label: 'Park the stuck message to a dead-letter topic', types: KAF, fixes: ['poison_message'] },
    tune_consumer_timeout: { label: 'Raise consumer session timeout and rejoin', types: KAF, fixes: ['rebalance_storm'] },
    kill_blocking_session: { label: 'Kill the blocking database session', types: DB, fixes: ['pool_exhausted'] },
    increase_pool_size: { label: 'Increase the connection pool size', types: DB },
    force_refresh: { label: 'Re-run the reference data load', types: REF, fixes: ['feed_failed'] },
    reset_sequence: { label: 'Reset session sequence numbers with the participant', types: SRC, fixes: ['session_down'] },
    apply_throttle: { label: 'Apply message throttle to the participant', types: SRC, fixes: ['order_flood'] },
    disconnect_participant: { label: 'Disconnect the participant', types: SRC },
    reload_announcement: { label: 'Reprocess the issuer’s corporate action file', types: ISS, fixes: ['announcement_missed'] },
  };
  function actionsFor(type) { return Object.fromEntries(Object.entries(ACTIONS).filter(([, a]) => a.types.includes(type))); }

  // ---------------------------------------------------------------- 4. root causes a responder can declare
  // Same list for every component. Real faults sit among plausible causes that never happen here.
  const CAUSES = [
    { group: 'Application', key: 'instances_lost', label: 'Instances lost (pods evicted)' },
    { group: 'Application', key: 'bad_deployment', label: 'Faulty code deployment' },
    { group: 'Application', key: 'config_change', label: 'Bad configuration change' },
    { group: 'Application', key: 'gc_pauses', label: 'Long garbage-collection pauses' },
    { group: 'Application', key: 'thread_deadlock', label: 'Thread deadlock in the application' },
    { group: 'Messaging', key: 'poison_message', label: 'Poison message blocking a partition' },
    { group: 'Messaging', key: 'rebalance_storm', label: 'Consumer group rebalance storm' },
    { group: 'Data', key: 'pool_exhausted', label: 'Connection pool exhausted by a long-running query' },
    { group: 'Data', key: 'db_deadlock', label: 'Database deadlocks' },
    { group: 'Data', key: 'feed_failed', label: 'Reference data feed failing (stale data)' },
    { group: 'Data', key: 'announcement_missed', label: 'Corporate action not applied' },
    { group: 'Infrastructure', key: 'disk_full', label: 'Disk full on the host' },
    { group: 'Infrastructure', key: 'memory_oom', label: 'Out of memory: process killed and crash-looping' },
    { group: 'Infrastructure', key: 'cpu_runaway', label: 'CPU saturated by another process on the host' },
    { group: 'Infrastructure', key: 'fd_exhausted', label: 'Too many open files (file descriptor limit)' },
    { group: 'Infrastructure', key: 'clock_skew', label: 'Host clock drift (NTP stopped)' },
    { group: 'Infrastructure', key: 'cert_expired', label: 'TLS client certificate expired' },
    { group: 'Infrastructure', key: 'network_loss', label: 'Network packet loss' },
    { group: 'Infrastructure', key: 'dns_failure', label: 'DNS resolution failure' },
    { group: 'APIs', key: 'api_rate_limited', label: 'API rate limit exceeded (HTTP 429)' },
    { group: 'APIs', key: 'api_auth_expired', label: 'API credentials expired (HTTP 401)' },
    { group: 'APIs', key: 'api_schema_change', label: 'API contract changed by the provider' },
    { group: 'APIs', key: 'api_dependency_down', label: 'Internal API dependency down' },
    { group: 'Participants and vendors', key: 'session_down', label: 'Session rejected: sequence number mismatch' },
    { group: 'Participants and vendors', key: 'order_flood', label: 'Message flood from the participant' },
    { group: 'Participants and vendors', key: 'unavailable', label: 'External platform down (their side)' },
    { group: 'Participants and vendors', key: 'market_volume', label: 'Unusually high market volume' },
  ];
  const causeLabel = k => (CAUSES.find(c => c.key === k) || {}).label || k;

  // ---------------------------------------------------------------- 5. blueprint parsing + validation
  function parseBlueprint(text, yaml) {
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
      if (!c.name) errors.push(`${where}: needs a "name".`);
      const T = TYPES[c.type];
      if (!T) { errors.push(`${where}: unknown type "${c.type}". Known types: ${Object.keys(TYPES).join(', ')}.`); return; }
      T.required.forEach(k => {
        if (typeof c[k] !== 'number' || !(c[k] > 0)) errors.push(`${where}: "${k}" is required and must be a positive number for type ${c.type}.`);
      });
      if (c.type === 'kafka_topic' && c.partitions > 64) errors.push(`${where}: at most 64 partitions.`);
      if (c.type === 'service' && c.instances !== undefined && !(Number.isInteger(c.instances) && c.instances > 0)) errors.push(`${where}: "instances" must be a positive whole number.`);
      if (c.type === 'service' && c.rejects !== undefined && !['queue', 'return'].includes(c.rejects)) errors.push(`${where}: "rejects" must be "queue" (held for reprocessing) or "return" (sent back to the sender).`);
      if (c.engine !== undefined && (c.type !== 'database' || !['oracle', 'postgres'].includes(c.engine))) errors.push(`${where}: "engine" is only for databases and must be oracle or postgres.`);
      if (c.uses !== undefined && !Array.isArray(c.uses)) errors.push(`${where}: "uses" must be a list of component ids.`);
    });
    comps.forEach(c => (c && Array.isArray(c.uses) ? c.uses : []).forEach(u => {
      const d = ids.get(u);
      if (!d) errors.push(`${c.id}: uses unknown component "${u}".`);
      else if (!['ref_data', 'database'].includes(d.type)) errors.push(`${c.id}: can only "use" reference data or databases, not ${d.type} "${u}".`);
      else if (c.type !== 'service') errors.push(`${c.id}: only services can "use" other components.`);
    }));
    comps.filter(c => c && c.type === 'issuer').forEach(c => {
      const d = ids.get(c.feeds);
      if (!d || d.type !== 'ref_data') errors.push(`${c.id}: issuers need "feeds" naming a reference data component.`);
    });

    const edges = [], edgeSet = new Set(), inFlow = new Set();
    (Array.isArray(bp.flow) ? bp.flow : []).forEach((line, i) => {
      const parts = String(line).split('->').map(s => s.trim()).filter(Boolean);
      if (parts.length < 2) { errors.push(`flow[${i}]: needs at least two components joined by "->".`); return; }
      let ok = true;
      parts.forEach(p => {
        const c = ids.get(p);
        if (!c) { errors.push(`flow[${i}]: unknown component "${p}".`); ok = false; return; }
        if (!TYPES[c.type] || !TYPES[c.type].flow) { errors.push(`flow[${i}]: ${c.type} "${p}" cannot be in the flow; attach it with "uses" or "feeds".`); ok = false; }
      });
      if (!ok) return;
      for (let j = 0; j < parts.length - 1; j++) {
        const k = parts[j] + '>' + parts[j + 1];
        if (parts[j] === parts[j + 1]) { errors.push(`flow[${i}]: "${parts[j]}" cannot feed itself.`); continue; }
        if (!edgeSet.has(k)) { edgeSet.add(k); edges.push([parts[j], parts[j + 1]]); }
      }
      parts.forEach(p => inFlow.add(p));
    });
    if (!edges.length) errors.push('Missing "flow" (for example: - oms -> trades_topic -> tam).');
    const ups = {}, downs = {};
    comps.forEach(c => { if (c && c.id) { ups[c.id] = []; downs[c.id] = []; } });
    edges.forEach(([a, b]) => { if (downs[a] && ups[b]) { downs[a].push(b); ups[b].push(a); } });
    comps.forEach(c => {
      if (!c || !c.id || !TYPES[c.type] || !TYPES[c.type].flow) return;
      if (!inFlow.has(c.id)) { errors.push(`${c.id}: is not connected in any flow.`); return; }
      if (c.type === 'source' && ups[c.id].length) errors.push(`${c.id}: a participant (source) cannot receive flow; it only sends.`);
      if (c.type !== 'source' && !ups[c.id].length) errors.push(`${c.id}: nothing flows into it. Every flow starts at a participant (type source).`);
      if (c.type === 'kafka_topic') {
        if (downs[c.id].length !== 1) errors.push(`${c.id}: a Kafka topic needs exactly one consumer after it (it has ${downs[c.id].length}).`);
        else if (ids.get(downs[c.id][0]).type !== 'service') errors.push(`${c.id}: the consumer after a Kafka topic must be a service.`);
      }
      if (c.type === 'service' && ups[c.id].some(u => ids.get(u).type === 'kafka_topic') && ups[c.id].length > 1)
        errors.push(`${c.id}: a service that consumes a Kafka topic can have only that topic as its input.`);
    });
    const order = [], state = {};
    let cycle = false;
    const visit = id => {
      if (state[id] === 2) return; if (state[id] === 1) { cycle = true; return; }
      state[id] = 1; (ups[id] || []).forEach(visit); state[id] = 2; order.push(id);
    };
    [...inFlow].forEach(visit);
    if (cycle) errors.push('The flow contains a loop. Flows must run one way, from participants to the end of the chain.');

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

    const dg = bp.diagram || {};
    const linked = (a, b) => edgeSet.has(a + '>' + b) || (ids.get(a) && (ids.get(a).uses || []).includes(b)) || (ids.get(a) && ids.get(a).feeds === b);
    (Array.isArray(dg.groups) ? dg.groups : []).forEach((g, i) => {
      if (!g || !g.label || !Array.isArray(g.ids)) { errors.push(`diagram.groups[${i}]: needs "label" and a list of "ids".`); return; }
      g.ids.forEach(id => { if (!ids.has(id)) errors.push(`diagram.groups[${i}] (${g.label}): unknown component "${id}".`); });
    });
    (Array.isArray(dg.steps) ? dg.steps : []).forEach((s, i) => {
      if (!s || !s.text) { errors.push(`diagram.steps[${i}]: needs "text".`); return; }
      if (!ids.has(s.from) || !ids.has(s.to)) errors.push(`diagram.steps[${i}]: "from" and "to" must be component ids.`);
      else if (!linked(s.from, s.to)) errors.push(`diagram.steps[${i}]: ${s.from} and ${s.to} are not connected (use a flow, "uses" or "feeds" link).`);
    });
    Object.entries(dg.place || {}).forEach(([id, p]) => {
      if (!ids.has(id)) errors.push(`diagram.place: unknown component "${id}".`);
      else if (!Array.isArray(p) || p.length !== 2 || p.some(v => typeof v !== 'number' || v < 0)) errors.push(`diagram.place.${id}: must be [column, row], for example [2, 0.5].`);
    });

    if (errors.length) return { errors };
    const sourceRate = comps.filter(c => c.type === 'source').reduce((s, c) => s + c.rate_per_min, 0);
    const model = {
      id: bp.id || 'blueprint', system: bp.system, description: bp.description || '',
      start, cutoff, components: comps, byId: Object.fromEntries(comps.map(c => [c.id, c])),
      edges, ups, downs, order, sourceRate,
      alerts: alerts.map((a, i) => ({ id: 'rule' + i, severity: 'P3', ...a })),
      business: {
        currency: biz.currency || '₹', unit: biz.unit || 'Cr', avg_notional: typeof biz.avg_notional === 'number' ? biz.avg_notional : 0.5,
        unit_name: biz.unit_name || 'trades',
        kpis, tolerance_trades: typeof biz.tolerance_trades === 'number' ? biz.tolerance_trades : sourceRate * 0.5,
      },
      diagram: { groups: dg.groups || [], steps: dg.steps || [], place: dg.place || {}, notes: dg.notes || '' },
      clockLabel: clock.cutoff_label || 'Cut-off',
      raw: bp,
    };
    return { errors: [], blueprint: model };
  }

  // ---------------------------------------------------------------- 6. the simulator
  function Simulator(bp, opts) {
    opts = opts || {};
    this.bp = bp;
    this.rand = rng(opts.seed || 42);
    this.t = bp.start - 30 * 60;       // warm up for 30 simulated minutes
    this.alerts = []; this.alertSeq = 1000; this.events = [];
    this.history = { t: [] }; this.lastSample = -Infinity;
    this.c = {};
    bp.components.forEach(def => { this.c[def.id] = this._initState(def); });
    bp.components.forEach(def => { this.c[def.id].ups = bp.ups[def.id] || []; this.c[def.id].downs = bp.downs[def.id] || []; });
    this.ruleState = {};
    this.biz = { produced: 0, prevCut: 0, netRate: 0, lost: 0 };
    this.warmup(bp.start - this.t);
  }

  Simulator.prototype._initState = function (def) {
    const s = { def, type: def.type, fault: null, logs: [], hist: {}, rates: {}, tot: { in: 0, out: 0, rej: 0, err: 0 }, win: { in: 0, out: 0, rej: 0, err: 0, n: 0 } };
    if (def.type === 'source') { s.held = 0; s.seqOut = 10000 + Math.floor(this.rand() * 500); }
    if (def.type === 'kafka_topic') { s.parts = new Array(def.partitions).fill(0); s.blocked = -1; s.rebalances = 0; s.offsets = new Array(def.partitions).fill(0).map((_, i) => 884000 + i * 3121); s.dlq = 0; }
    if (def.type === 'service') { s.inbox = 0; s.retry = 0; s.rejected = 0; s.configured = def.instances || 4; s.instances = s.configured; s.restartUntil = -1; s.rejectLog = []; s.oomRestarts = 0; }
    if (def.type === 'external_party') { s.inbox = 0; s.recoverAt = -1; s.adapterDownUntil = -1; }
    if (def.type === 'ref_data') { s.lastRefresh = this.t; s.records = 48210; }
    if (def.type === 'database') { s.used = Math.round(def.pool_size * 0.28); }
    if (hasHost(def.type)) { const h = hash(def.id); s.host = { fault: null, outageUntil: -1, disk: 34 + h % 27, cpu: 18 + h % 17, mem: 52 + h % 14 }; }
    return s;
  };

  Simulator.prototype.now = function () { return this.t; };
  Simulator.prototype.time = function (sec) { return clockStr(this.t, sec); };
  Simulator.prototype.log = function (id, level, msg) {
    const s = this.c[id];
    s.logs.push({ t: this.t, level, msg, id, line: `${clockStr(this.t, true)} ${level.padEnd(5)} [${id}] ${msg}` });
    if (s.logs.length > 600) s.logs.splice(0, s.logs.length - 600);
  };
  Simulator.prototype.chance = function (p) { return this.rand() < p; };
  Simulator.prototype.sessionId = function (s) { return s.def.session || s.def.id.toUpperCase().slice(0, 6); };

  // host helpers
  Simulator.prototype.hostFault = function (s) { return s && s.host && s.host.fault ? s.host.fault.type : null; };
  Simulator.prototype.inOutage = function (s) { return !!(s && s.host && this.t < s.host.outageUntil); };
  Simulator.prototype.oomUp = function (s) { // crash loop: about 45 s up, 135 s down while Kubernetes backs off
    const ph = (this.t - s.host.fault.since) % 180; return ph < 45;
  };
  Simulator.prototype.hostFactor = function (s) {
    if (!s.host) return 1;
    if (this.inOutage(s)) return 0;
    switch (this.hostFault(s)) {
      case 'disk_full': return 0;
      case 'memory_oom': return this.oomUp(s) ? 1 : 0;
      case 'cpu_runaway': return 0.45;
      case 'fd_exhausted': return 0.4;
      default: return 1;
    }
  };
  Simulator.prototype.dbFactor = function (d) { // how a database's state slows the services that use it
    if (this.inOutage(d)) return 0;
    const hf = this.hostFault(d);
    if (hf === 'disk_full') return 0; // archiver stuck: no commits
    let f = 1;
    if (hf === 'cpu_runaway') f *= 0.5;
    if (d.fault && d.fault.type === 'pool_exhausted') f *= 0.2;
    return f;
  };
  Simulator.prototype.extDown = function (s) { // external connection unusable, and why
    if (s.fault && s.fault.type === 'unavailable') return 'vendor';
    if (s.fault && s.fault.type === 'api_auth_expired') return 'auth';
    if (this.t < s.adapterDownUntil || this.inOutage(s)) return 'restart';
    const hf = this.hostFault(s);
    if (hf === 'cert_expired') return 'cert';
    if (hf === 'disk_full') return 'disk';
    return null;
  };
  // why a participant's session is down: its own sequence mismatch, or the gateway host's clock
  Simulator.prototype.sourceDown = function (s) {
    if (s.fault && s.fault.type === 'session_down') return 'seq';
    if (s.downs.some(d => this.hostFault(this.c[d]) === 'clock_skew')) return 'clock';
    return null;
  };

  Simulator.prototype.serviceFactor = function (s) {
    let f = s.instances / s.configured;
    if (this.t < s.restartUntil) f *= 0.5;
    f *= this.hostFactor(s);
    if (s.fault && s.fault.type === 'config_change') f *= 0.4;
    (s.def.uses || []).forEach(u => { const d = this.c[u]; if (d.type === 'database') f *= this.dbFactor(d); });
    s.ups.forEach(u => { const up = this.c[u]; if (up.type === 'kafka_topic' && up.fault && up.fault.type === 'rebalance_storm') f *= 0.35; });
    return f;
  };
  Simulator.prototype.staleness = function (d) { return (this.t - d.lastRefresh) / 60; };
  Simulator.prototype.staleRefs = function (s) {
    return (s.def.uses || []).map(u => this.c[u]).filter(d => d.type === 'ref_data' && this.staleness(d) > d.def.stale_after_min);
  };
  Simulator.prototype.issuersOf = function (refId) { return Object.values(this.c).filter(x => x.type === 'issuer' && x.def.feeds === refId); };
  Simulator.prototype.rejectCauses = function (s) {
    const out = [];
    this.staleRefs(s).forEach(r => out.push({ share: 0.08, ref: r, kind: 'stale' }));
    (s.def.uses || []).forEach(u => this.issuersOf(u).forEach(is => {
      if (is.fault && is.fault.type === 'announcement_missed') out.push({ share: is.fault.params.reject_share, ref: this.c[u], issuer: is, kind: 'issuer' });
    }));
    return out;
  };

  Simulator.prototype.accept = function (id, n) {
    const s = this.c[id];
    s.tot.in += n; s.win.in += n;
    if (s.type === 'kafka_topic') {
      const per = n / s.parts.length;
      for (let i = 0; i < s.parts.length; i++) { s.parts[i] += per; s.offsets[i] += per; }
    } else if (s.type === 'service' || s.type === 'external_party') s.inbox += n;
  };
  Simulator.prototype.emit = function (s, n) { s.downs.forEach(d => this.accept(d, n)); };

  Simulator.prototype.step = function (dt) {
    this.t += dt;
    Object.values(this.c).filter(s => s.type === 'ref_data').forEach(s => {
      if (this.t - s.lastRefresh < s.def.refresh_every_min * 60) return;
      const hostBad = this.hostFault(s) === 'disk_full' || this.inOutage(s);
      if ((s.fault && s.fault.type === 'feed_failed') || hostBad) {
        if (!s.lastFailLog || this.t - s.lastFailLog >= 300) {
          s.lastFailLog = this.t;
          if (hostBad) this.log(s.def.id, 'ERROR', `${s.def.name} load FAILED: No space left on device writing ${MOUNT.ref_data}/ssi_${clockStr(this.t).replace(':', '')}.csv`);
          else this.log(s.def.id, 'ERROR', `${s.def.name} feed job FAILED: sftp://feeds.vendor.example:22 connection refused`);
        }
      } else {
        s.lastRefresh = this.t; s.records += Math.floor(this.rand() * 40);
        const missed = this.issuersOf(s.def.id).filter(is => is.fault && is.fault.type === 'announcement_missed');
        if (missed.length) this.log(s.def.id, 'WARN', `${s.def.name} loaded ${fmtInt(s.records)} records; corporate action file ${missed.map(m => m.fault.ca).join(', ')} skipped: unknown ISIN format`);
        else this.log(s.def.id, 'INFO', `${s.def.name} loaded: ${fmtInt(s.records)} records`);
      }
    });
    Object.values(this.c).filter(s => s.type === 'database').forEach(s => {
      const P = s.def.pool_size;
      if ((s.fault && s.fault.type === 'pool_exhausted') || this.hostFault(s) === 'disk_full') s.used = P;
      else s.used = Math.max(2, Math.min(P, Math.round(P * (0.24 + this.rand() * 0.1))));
    });
    this.bp.order.forEach(id => this._process(id, dt));
    Object.values(this.c).forEach(s => {
      if (s.type === 'external_party' && s.recoverAt > 0 && this.t >= s.recoverAt) {
        s.recoverAt = -1; this.clearFault(s.def.id, 'External party reports platform restored');
        this.log(s.def.id, 'INFO', `${s.def.name} responding normally again (incident closed by the external party)`);
      }
      if (s.type === 'service' && this.hostFault(s) === 'memory_oom') {
        const ph = (this.t - s.host.fault.since) % 180;
        if (ph < dt) { s.oomRestarts++; this.log(s.def.id, 'ERROR', `java.lang.OutOfMemoryError: Java heap space (heap 6144 MB)`); this.log(s.def.id, 'WARN', `Container ${s.def.id}-7f9c-1 OOMKilled (exit 137); restart #${s.oomRestarts}, back-off ${Math.min(300, 10 * 2 ** s.oomRestarts)}s`); }
        if (ph >= 45 && ph - dt < 45) this.log(s.def.id, 'INFO', `Starting ${s.def.name} (heap 6144 MB)... CrashLoopBackOff wait`);
      }
    });
    this._chatter(dt);
    this._rates(dt);
    this._business(dt);
    this._evalAlerts();
    if (this.t - this.lastSample >= 60) { this.lastSample = this.t; this._sample(); }
  };

  const x429 = (s, min) => s.def.capacity_per_min * min * 0.6; // throttled calls that come back 429 and are retried at once
  Simulator.prototype._process = function (id, dt) {
    const s = this.c[id], def = s.def, min = dt / 60;
    if (s.type === 'source') {
      const mult = s.fault && s.fault.type === 'order_flood' ? (s.fault.params.multiplier || 4) : 1;
      const n = def.rate_per_min * mult * min * (0.94 + this.rand() * 0.12);
      this.biz.produced += n;
      if (this.sourceDown(s)) { s.held += n; return; }
      let send = n;
      if (s.held > 0) { const r = Math.min(s.held, def.rate_per_min * 2 * min); s.held -= r; send += r; }
      s.tot.out += send; s.win.out += send; s.seqOut += Math.round(send);
      this.emit(s, send);
      return;
    }
    if (s.type === 'kafka_topic') return;
    if (s.type === 'service') {
      const kafkaUp = s.ups.length === 1 && this.c[s.ups[0]].type === 'kafka_topic' ? this.c[s.ups[0]] : null;
      let cap = def.capacity_per_min * this.serviceFactor(s) * min;
      const r = Math.min(s.retry, cap); s.retry -= r; cap -= r;
      let got = r;
      if (kafkaUp) {
        const up = kafkaUp;
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
      const causes = this.rejectCauses(s);
      const rejFrac = Math.min(0.9, causes.reduce((a, c) => a + c.share, 0));
      const rej = got * rejFrac;
      if (rej > 0) {
        const c = causes[Math.floor(this.rand() * causes.length)];
        s.rejectLog.push({ t: this.t, n: rej, kind: c.kind, ref: c.ref.def.name, symbol: c.issuer ? (c.issuer.def.symbol || c.issuer.def.id.toUpperCase()) : null, ca: c.issuer ? c.issuer.fault.ca : null });
        if (s.rejectLog.length > 300) s.rejectLog.shift();
      }
      if (def.rejects !== 'return') s.rejected += rej;
      s.tot.rej += rej; s.win.rej += rej;
      const ok = got - rej;
      s.tot.out += ok; s.win.out += ok;
      const dbBad = (def.uses || []).some(u => { const d = this.c[u]; return d.type === 'database' && this.dbFactor(d) < 1; });
      if (dbBad) s.win.err += got * 0.06 + 0.5;
      const hf = this.hostFault(s);
      if (hf === 'fd_exhausted') s.win.err += got * 0.3 + 1;
      if (s.fault && s.fault.type === 'config_change') s.win.err += got * 0.8 + 1;
      if (hf === 'disk_full' || (hf === 'memory_oom' && !this.oomUp(s)) || this.inOutage(s)) s.win.err += 2;
      this.emit(s, ok);
      return;
    }
    if (s.type === 'external_party') {
      const down = this.extDown(s);
      let cap = down ? 0 : def.capacity_per_min * min;
      if (!down && this.hostFault(s) === 'fd_exhausted') cap *= 0.4;
      if (!down && s.fault && s.fault.type === 'api_rate_limited') { cap *= 0.35; s.win.err += x429(s, min); }
      const x = Math.min(s.inbox, cap); s.inbox -= x;
      s.tot.out += x; s.win.out += x;
      if (down) s.win.err += 3;
      this.emit(s, x);
    }
  };

  // realistic log lines, driven by the current state (never by the drill script)
  Simulator.prototype._chatter = function (dt) {
    const p = dt / 30;
    const blk = () => `BLK-${71000 + Math.floor(this.rand() * 900)}`;
    Object.values(this.c).forEach(s => {
      const id = s.def.id, name = s.def.name, f = s.fault && s.fault.type, hf = this.hostFault(s);
      if (s.type === 'source') {
        const why = this.sourceDown(s);
        if (!why && this.chance(p * 0.6)) {
          const tgt = s.downs.length ? this.c[s.downs[0]].def.name : 'downstream';
          this.log(id, 'INFO', `Session ${this.sessionId(s)}: sent ${Math.round(this.rates(id).out_rate / 2)} messages to ${tgt} (seq ${fmtInt(s.seqOut)})`);
        }
        if (why && this.chance(p * 0.7)) this.log(id, 'WARN', `Session ${this.sessionId(s)}: logon attempt failed, retrying in 30s (${fmtInt(s.held)} orders queued)`);
      }
      if (s.type === 'kafka_topic') {
        if (s.blocked >= 0 && this.chance(p * 0.6)) this.log(id, 'WARN', `Consumer offset for ${name}-${s.blocked} not advancing at ${Math.floor(s.stuckOffset)} (lag ${fmtInt(s.parts[s.blocked])})`);
        if (f === 'rebalance_storm' && this.chance(p * 1.4)) { s.rebalances++; this.log(id, 'WARN', `Group ${s.def.consumer_group || 'consumers'} rebalancing (generation ${400 + s.rebalances}): member left, session timeout 10000ms`); }
        if (!f && this.chance(p * 0.3)) this.log(id, 'INFO', `Group ${s.def.consumer_group || 'consumers'} stable: ${this._consumerCount(s)} members, ${s.parts.length} partitions`);
      }
      if (s.type === 'service') {
        s.ups.forEach(u => {
          const up = this.c[u];
          if (up.type === 'kafka_topic' && up.blocked >= 0 && this.chance(p * 1.5))
            this.log(id, 'ERROR', `Failed to deserialize record ${up.def.name}-${up.blocked}@${Math.floor(up.stuckOffset)}: Unrecognized field "allocRatioV2" (class TradeEvent) — retrying`);
          if (up.type === 'kafka_topic' && up.fault && up.fault.type === 'rebalance_storm' && this.chance(p))
            this.log(id, 'WARN', `Partitions revoked [0, 1, 2]; rejoining group ${up.def.consumer_group || ''}`.trim());
          if (up.type === 'source') {
            const why = this.sourceDown(up);
            if (why === 'seq' && this.chance(p * 1.2)) this.log(id, 'ERROR', `Logon rejected for session ${this.sessionId(up)} (${up.def.name}): MsgSeqNum ${fmtInt(up.seqOut - 334)} lower than expected ${fmtInt(up.seqOut)}; disconnecting`);
            if (why === 'clock' && this.chance(p * 0.9)) this.log(id, 'ERROR', `Logon rejected for session ${this.sessionId(up)} (${up.def.name}): SendingTime accuracy problem (difference ${s.host.fault.params.seconds}s); disconnecting`);
            if (up.fault && up.fault.type === 'order_flood' && this.chance(p * 1.3))
              this.log(id, 'WARN', `Session ${this.sessionId(up)} (${up.def.name}) sending ${fmtInt(this.rates(u).out_rate)} msgs/min, above its ${fmtInt(up.def.rate_per_min * 1.5)} msgs/min limit; inbound queue ${fmtInt(s.inbox)}`);
          }
        });
        if (f === 'instances_lost' && this.chance(p * 0.8))
          this.log(id, 'WARN', `Only ${s.instances}/${s.configured} ${name} instances ready; pods ${id}-${s.instances + 1}, ${id}-${s.configured} Pending (node memory pressure)`);
        (s.def.uses || []).forEach(u => {
          const d = this.c[u]; if (d.type !== 'database') return;
          if (this.hostFault(d) === 'disk_full' && isPg(d) && this.chance(p * 1.6)) this.log(id, 'ERROR', `org.postgresql.util.PSQLException: ERROR: could not extend file "base/16384/${24576 + Math.floor(this.rand() * 40)}": No space left on device (${blk()} insert failed)`);
          else if (this.hostFault(d) === 'disk_full' && this.chance(p * 1.6)) this.log(id, 'ERROR', `ORA-00257: Archiver error. Connect AS SYSDBA only until resolved (${blk()} commit failed)`);
          else if (d.fault && d.fault.type === 'pool_exhausted' && this.chance(p * 1.6)) this.log(id, 'ERROR', `HikariPool-1 - Connection is not available, request timed out after 30000ms (${blk()})`);
          else if (this.hostFault(d) === 'cpu_runaway' && this.chance(p)) this.log(id, 'WARN', `Slow query 3,8${Math.floor(this.rand() * 9)}0ms on ${d.def.name} (expected < 200ms)`);
        });
        if (hf === 'disk_full' && this.chance(p * 1.4)) this.log(id, 'ERROR', `java.io.IOException: No space left on device (writing ${MOUNT.service}/app/${id}.log); request failed`);
        if (hf === 'cpu_runaway' && this.chance(p)) this.log(id, 'WARN', `Request p99 ${fmtInt(2200 + this.rand() * 900)}ms; worker threads waiting for CPU`);
        if (hf === 'fd_exhausted' && this.chance(p * 1.5)) this.log(id, 'ERROR', `java.net.SocketException: Too many open files (accept failed on :8443)`);
        if (f === 'config_change' && this.chance(p * 1.6)) this.log(id, 'ERROR', `java.net.SocketTimeoutException: Read timed out after ${s.fault.params.timeout_ms}ms calling ${s.fault.params.api} POST /v2/check (attempt 3/3); request failed`);
        this.rejectCauses(s).forEach(c => {
          if (!this.chance(p * 1.4)) return;
          if (c.kind === 'stale') this.log(id, 'ERROR', `Rejected ${blk()}: no SSI for account ACC-${48000 + Math.floor(this.rand() * 900)} in ${c.ref.def.name}`);
          else this.log(id, 'ERROR', `Order rejected: price ${(1100 + this.rand() * 200).toFixed(2)} outside band for ${c.issuer.def.symbol || c.issuer.def.id.toUpperCase()} (band not updated for ${c.issuer.fault.ca})`);
        });
        if (this.t < s.restartUntil && this.chance(p)) this.log(id, 'INFO', `Rolling restart in progress: instance ${1 + Math.floor(this.rand() * s.configured)}/${s.configured} restarting`);
        if (this.hostFactor(s) > 0 && this.chance(p * 0.6)) this.log(id, 'INFO', `Processed ${fmtInt(this.rates(id).out_rate / 2)} in last 30s (queue ${fmtInt(this.metric(id, 'backlog'))})`);
      }
      if (s.type === 'external_party') {
        const why = this.extDown(s);
        if (why && this.chance(p * 1.6)) {
          if (why === 'vendor') this.log(id, 'ERROR', `${name} API POST /v1/messages returned 503 Service Unavailable (retry ${1 + Math.floor(this.rand() * 5)}/5)`);
          if (why === 'cert') this.log(id, 'ERROR', `SSLHandshakeException: PKIX path validation failed: certificate expired (client cert CN=${id}-adapter); connection to ${name} closed`);
          if (why === 'disk') this.log(id, 'ERROR', `Cannot spool outbound message: No space left on device (${MOUNT.external_party})`);
          if (why === 'restart') this.log(id, 'WARN', `${name} connection not ready (adapter starting)`);
          if (why === 'auth') this.log(id, 'ERROR', `${name} API POST /v1/messages returned 401 Unauthorized: {"error":"invalid_client","error_description":"client secret expired"}`);
        } else if (!why && f === 'api_rate_limited' && this.chance(p * 1.8)) {
          this.log(id, 'WARN', `${name} API POST /v1/messages returned 429 Too Many Requests (Retry-After: 30); retrying immediately (attempt ${1 + Math.floor(this.rand() * 5)}/5)`);
        } else if (!why && hf === 'fd_exhausted' && this.chance(p * 1.4)) this.log(id, 'ERROR', `java.net.SocketException: Too many open files (connect to ${name})`);
        else if (!why && !f && this.chance(p * 0.5)) this.log(id, 'INFO', `${name}: ${fmtInt(this.rates(id).out_rate / 2)} messages acknowledged in last 30s`);
      }
      if (s.type === 'database') {
        if (hf === 'disk_full' && isPg(s) && this.chance(p)) this.log(id, 'ERROR', `PANIC: could not write to file "pg_wal/00000001000000A2000000${(64 + Math.floor(this.t / 300) % 190).toString(16).toUpperCase()}": No space left on device`);
        else if (hf === 'disk_full' && this.chance(p)) this.log(id, 'ERROR', `ARC0: Error 19809 creating archive log file to '${MOUNT.database}/1_${48210 + Math.floor(this.t / 300)}.arc'; ORA-19815: destination is 100% full`);
        else if (f === 'pool_exhausted' && this.chance(p)) this.log(id, 'WARN', `Session 482 (month_end_recon_report) running ${Math.round((this.t - s.fault.since) / 60) + 14} min, holding ${s.def.pool_size - 4} connections`);
        else if (this.chance(p * 0.25)) this.log(id, 'INFO', `Pool active ${s.used}/${s.def.pool_size}, idle ${s.def.pool_size - s.used}`);
      }
    });
  };
  Simulator.prototype._consumerCount = function (k) {
    const svc = k.downs.length && this.c[k.downs[0]];
    return svc && svc.type === 'service' ? svc.instances : 1;
  };

  Simulator.prototype._rates = function (dt) {
    Object.values(this.c).forEach(s => {
      const w = s.win; w.n += dt;
      if (w.n < 30) return;
      const k = 60 / w.n, a = 0.5;
      const prev = s.rates;
      const nr = { in_rate: w.in * k, out_rate: w.out * k, rej_rate: w.rej * k, err_rate: w.err * k };
      s.rates = prev.n ? Object.fromEntries(Object.keys(nr).map(x => [x, prev[x] * (1 - a) + nr[x] * a])) : nr;
      s.rates.n = 1;
      s.win = { in: 0, out: 0, rej: 0, err: 0, n: 0 };
    });
  };
  Simulator.prototype.rates = function (id) { const r = this.c[id].rates; return r.n ? r : { in_rate: 0, out_rate: 0, rej_rate: 0, err_rate: 0 }; };

  Simulator.prototype.hostMetric = function (s, m) {
    const h = s.host, hf = this.hostFault(s), j = this.rand() * 3;
    if (m === 'host_disk_pct') return hf === 'disk_full' ? 100 : h.disk + j * 0.3;
    if (m === 'host_cpu_pct') return hf === 'cpu_runaway' ? 97 + j : Math.min(95, h.cpu + j + (s.type === 'service' ? 25 * (1 - Math.min(1, this.serviceFactor(s))) : 0));
    if (m === 'host_mem_pct') return hf === 'memory_oom' ? (this.oomUp(s) ? 91 + j * 2 : 38) : h.mem + j;
    return 0;
  };
  Simulator.prototype.metric = function (id, m) {
    const s = this.c[id], r = this.rates(id);
    if (m.startsWith('host_')) return s.host ? this.hostMetric(s, m) : 0;
    switch (s.type) {
      case 'source':
        if (m === 'out_rate') return r.out_rate;
        if (m === 'held') return s.held;
        return 0;
      case 'kafka_topic':
        if (m === 'lag') return s.parts.reduce((a, b) => a + b, 0);
        if (m === 'max_partition_lag') return Math.max(...s.parts);
        if (m === 'in_rate') return r.in_rate;
        if (m === 'out_rate') return r.out_rate;
        if (m === 'rebalances') return s.rebalances;
        return 0;
      case 'service': {
        const kafkaUp = s.ups.length === 1 && this.c[s.ups[0]].type === 'kafka_topic';
        const backlog = (kafkaUp ? 0 : s.inbox) + s.retry;
        const processed = r.out_rate + r.rej_rate;
        if (m === 'backlog') return backlog;
        if (m === 'in_rate') return kafkaUp ? processed : r.in_rate;
        if (m === 'out_rate') return r.out_rate;
        if (m === 'reject_rate') return processed > 1 ? 100 * r.rej_rate / processed : 0;
        if (m === 'error_rate') return processed > 1 ? Math.min(100, 100 * r.err_rate / processed) : (r.err_rate > 0 ? 100 : 0);
        if (m === 'instances') return this.hostFault(s) === 'memory_oom' && !this.oomUp(s) ? 0 : this.hostFault(s) === 'disk_full' || this.inOutage(s) ? 0 : s.instances;
        if (m === 'rejected') return s.rejected;
        if (m === 'sessions_down') return s.ups.filter(u => this.c[u].type === 'source' && this.sourceDown(this.c[u])).length;
        if (m === 'latency_ms') { const f = this.serviceFactor(s); const q = backlog / Math.max(1, s.def.capacity_per_min * f) * 60000; return Math.round(140 / Math.max(f, 0.05) * (0.95 + this.rand() * 0.1) + Math.min(q, 600000)); }
        return 0;
      }
      case 'external_party':
        if (m === 'backlog') return s.inbox;
        if (m === 'in_rate') return r.in_rate;
        if (m === 'out_rate') return r.out_rate;
        if (m === 'error_rate') return this.extDown(s) ? 100 : this.hostFault(s) === 'fd_exhausted' ? 60 : s.fault && s.fault.type === 'api_rate_limited' ? 64 : 0;
        return 0;
      case 'ref_data': return m === 'staleness_min' ? this.staleness(s) : 0;
      case 'database':
        if (m === 'pool_used') return s.used;
        if (m === 'pool_pct') return 100 * s.used / s.def.pool_size;
        if (m === 'wait_ms') return this.dbFactor(s) < 0.3 ? 30000 : this.dbFactor(s) < 1 ? 900 + Math.round(this.rand() * 400) : 2 + Math.round(this.rand() * 6);
        return 0;
      case 'issuer': return m === 'pending_announcements' ? (s.fault ? 1 : 0) : 0;
    }
    return 0;
  };

  // business KPIs: work produced but not yet past a stage
  Simulator.prototype.kpi = function (k) {
    const s = this.c[k.at];
    const returned = s.type === 'service' && s.def.rejects === 'return' ? s.tot.rej : 0;
    const trades = Math.max(0, this.biz.produced - s.tot.out - returned - this._rejectedUpstream(k.at));
    return { label: k.label, trades, notional: trades * this.bp.business.avg_notional, cutoff: !!k.cutoff };
  };
  Simulator.prototype._rejectedUpstream = function (at) {
    let n = 0; const seen = new Set();
    const walk = id => (this.bp.ups[id] || []).forEach(u => { if (seen.has(u)) return; seen.add(u); const s = this.c[u]; if (s.type === 'service' && s.def.rejects === 'return') n += s.tot.rej; walk(u); });
    walk(at); return n;
  };
  Simulator.prototype.kpis = function () { return this.bp.business.kpis.map(k => this.kpi(k)); };
  Simulator.prototype.cutoffKpi = function () { const k = this.bp.business.kpis.find(x => x.cutoff); return k ? this.kpi(k) : null; };
  Simulator.prototype._business = function (dt) {
    const k = this.cutoffKpi(); if (!k) return;
    const net = (k.trades - this.biz.prevCut) / (dt / 60);
    this.biz.prevCut = k.trades;
    this.biz.netRate = this.biz.netRate * 0.9 + net * 0.1;
  };
  Simulator.prototype.cutoffRisk = function () {
    const k = this.cutoffKpi(); if (!k) return { atRisk: false };
    const tol = this.bp.business.tolerance_trades, left = (this.bp.cutoff - this.t) / 60;
    if (k.trades <= tol * 2) return { atRisk: false, eta: null };
    if (this.biz.netRate >= -1) return { atRisk: true, eta: null };
    const eta = (k.trades - tol) / -this.biz.netRate;
    return { atRisk: eta > left, eta };
  };

  Simulator.prototype._evalAlerts = function () {
    if (this.t < this.bp.start) return;
    const rules = this.bp.alerts.slice();
    const k = this.cutoffKpi();
    if (k) rules.push({ id: 'cutoff', name: `${k.label} — ${this.bp.clockLabel.toLowerCase()} at risk`, on: this.bp.business.kpis.find(x => x.cutoff).at, severity: 'P1', builtin: true });
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
        if (!st.alert && this.t - st.since >= 60) {
          const a = { id: 'ALRT-' + (++this.alertSeq), rule: rule.id, name: rule.name, severity: rule.severity || 'P3', on: rule.on, metric: rule.metric || 'business', threshold: rule.builtin ? 'projected past cut-off' : (typeof rule.above === 'number' ? '> ' + rule.above : '< ' + rule.below), value: val, firedAt: this.t, resolvedAt: null, status: 'FIRING', source: rule.source || 'Grafana' };
          st.alert = a; this.alerts.unshift(a);
          this.events.push({ t: this.t, kind: 'alert', text: `${a.id} ${a.severity} ${a.name} fired` });
        }
        if (st.alert) st.alert.value = val;
      } else {
        st.since = null;
        if (st.alert) {
          if (st.clearSince === null) st.clearSince = this.t;
          if (this.t - st.clearSince >= 120) {
            st.alert.status = 'RESOLVED'; st.alert.resolvedAt = this.t;
            this.events.push({ t: this.t, kind: 'alert', text: `${st.alert.id} ${st.alert.name} resolved` });
            st.alert = null;
          }
        }
      }
    });
  };
  Simulator.prototype.addExternalAlert = function (a) {
    const al = { id: 'ALRT-' + (++this.alertSeq), firedAt: this.t, resolvedAt: null, status: 'FIRING', severity: 'P4', metric: 'external', value: '', threshold: '', source: 'Infrastructure', ...a };
    this.alerts.unshift(al); return al;
  };

  Simulator.prototype._sample = function () {
    this.history.t.push(this.t);
    Object.values(this.c).forEach(s => {
      Object.keys(TYPES[s.type].metrics).forEach(m => { (s.hist[m] || (s.hist[m] = [])).push(this.metric(s.def.id, m)); });
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
    const rate = this.bp.sourceRate || 1;
    switch (s.type) {
      case 'source': { const why = this.sourceDown(s); return why ? 'bad' : s.fault ? 'warn' : 'ok'; }
      case 'kafka_topic': { const L = m('lag'), P = m('max_partition_lag'); return L > rate * 8 || P > rate * 2 ? 'bad' : L > rate * 2 || P > rate * 0.8 / Math.max(1, s.parts.length / 6) ? 'warn' : 'ok'; }
      case 'service': {
        if (this.serviceFactor(s) < 0.3 || m('reject_rate') > 5) return 'bad';
        if (s.instances < s.configured || m('error_rate') > 2 || this.serviceFactor(s) < 0.9) return 'warn';
        if (m('reject_rate') > 1 || s.rejected > 5 || m('backlog') > rate * 2 || m('sessions_down') > 0) return 'warn';
        return 'ok';
      }
      case 'external_party': return m('error_rate') > 50 ? 'bad' : m('backlog') > rate * 2 || m('error_rate') > 0 ? 'warn' : 'ok';
      case 'ref_data': { const st = m('staleness_min'); return st > s.def.stale_after_min * 1.5 ? 'bad' : st > s.def.stale_after_min ? 'warn' : 'ok'; }
      case 'database': { const p = m('pool_pct'); return p > 95 ? 'bad' : p > 85 || this.dbFactor(s) < 1 ? 'warn' : 'ok'; }
      case 'issuer': return 'ok'; // an exchange cannot see inside a listed company; the signal is downstream
    }
    return 'ok';
  };

  // ---------------------------------------------------------------- faults and actions
  Simulator.prototype.injectFault = function (id, type, params) {
    const s = this.c[id];
    if (!s) throw new Error(`No component "${id}"`);
    const F = faultsFor(s.type)[type];
    if (!F) throw new Error(`${s.type} "${id}" has no fault "${type}"`);
    const p = { ...F.params, ...(params || {}) };
    const fault = { type, params: p, since: this.t };
    if (F.host) {
      s.host.fault = fault;
      if (type === 'cpu_runaway') this.log(id, 'INFO', 'cron: started backup_agent --full --target=/mnt/nfs/backup (nightly job, rescheduled)');
      if (type === 'clock_skew') this.log(id, 'WARN', 'chronyd: no reachable NTP sources; clock unsynchronised');
    } else {
      s.fault = fault;
      if (type === 'poison_message') { s.blocked = Math.min(s.parts.length - 1, Math.max(0, p.partition | 0)); s.stuckOffset = s.offsets[s.blocked] - s.parts[s.blocked]; }
      if (type === 'instances_lost') s.instances = Math.max(1, Math.min(s.configured - 1, p.remaining | 0));
      if (type === 'feed_failed') s.lastRefresh = Math.min(s.lastRefresh, this.t - p.last_refresh_minutes_ago * 60);
      if (type === 'pool_exhausted') this.log(id, 'WARN', `Long-running query started: session 482 (month_end_recon_report), full table scan on ${s.def.big_table || 'ALLOCATION_HIST'}`);
      if (type === 'announcement_missed') fault.ca = `CA-2026-${100 + Math.floor(this.rand() * 80)}`;
      if (type === 'config_change') { fault.commit = '7c1e2a9'; this.log(id, 'INFO', `Configuration refreshed from config-server (commit ${fault.commit} by ops-automation): http.client.${p.api}.read-timeout-ms=${p.timeout_ms}`); }
      if (type === 'api_auth_expired') this.log(id, 'WARN', `OAuth token refresh failed for client ${id}-adapter: invalid_client`);
      if (type === 'session_down') this.log(id, 'ERROR', `Session ${this.sessionId(s)}: disconnected by counterparty after logon rejected (sequence number too low)`);
    }
    this.events.push({ t: this.t, kind: 'fault', hidden: true, text: `Fault injected: ${F.label} on ${s.def.name}` });
    return fault;
  };
  Simulator.prototype.clearFault = function (id, why, host) {
    const s = this.c[id];
    if (host) { if (!s.host || !s.host.fault) return; s.host.fault = null; }
    else { if (!s.fault) return; if (s.type === 'kafka_topic') s.blocked = -1; s.fault = null; }
    this.events.push({ t: this.t, kind: 'fixed', text: `${s.def.name}: ${why}` });
  };
  Simulator.prototype.actionsFor = function (id) { const s = this.c[id]; return s ? actionsFor(s.type) : {}; };

  Simulator.prototype.applyAction = function (id, action) {
    const s = this.c[id];
    if (!s) return { ok: false, message: `No component "${id}"` };
    const A = ACTIONS[action];
    if (!A || !A.types.includes(s.type)) return { ok: false, message: `“${A ? A.label : action}” does not apply to ${s.def.name}.` };
    const f = s.fault && s.fault.type, hf = this.hostFault(s), name = s.def.name, host = `${id.replace(/_/g, '-')} host`;
    let message, effect = 'none';
    const fixHost = why => { this.clearFault(id, why, true); effect = 'fixed'; };
    switch (action) {
      case 'reset_sequence':
        if (f === 'session_down') { message = `Sequence numbers reset with ${name}; session ${this.sessionId(s)} logged on. ${fmtInt(s.held)} queued orders are being resent.`; this.clearFault(id, 'session sequence reset, participant reconnected'); effect = 'fixed'; this.log(id, 'INFO', `Session ${this.sessionId(s)}: logon accepted after sequence reset`); }
        else if (this.sourceDown(s) === 'clock') message = `Sequence numbers reset, but the logon is rejected again: “SendingTime accuracy problem”. The sequence numbers were not the issue.`;
        else message = `Session ${this.sessionId(s)} was already connected; the reset forced a brief logout and logon.`;
        break;
      case 'apply_throttle':
        if (f === 'order_flood') { message = `Throttle of ${fmtInt(s.def.rate_per_min * 1.5)} msgs/min applied to ${name}. Excess messages are rejected back to the participant.`; this.clearFault(id, 'participant throttled'); effect = 'fixed'; }
        else message = `Throttle applied to ${name}, which was within its limit. Its orders may now be rejected unnecessarily.`;
        break;
      case 'disconnect_participant':
        message = `${name} disconnected. Its orders now queue on its side and it will call the exchange.`;
        s.fault = { type: 'session_down', params: {}, since: this.t, operator: true }; // an operator-caused outage the responder must undo
        break;
      case 'skip_poison_message':
        if (f === 'poison_message') { s.dlq++; message = `Parked ${name}-${s.blocked}@${Math.floor(s.stuckOffset)} to ${name}.DLQ; partition ${s.blocked} consuming again. 1 message needs manual repair.`; this.log(id, 'INFO', `Offset ${Math.floor(s.stuckOffset)} on partition ${s.blocked} skipped and parked to DLQ`); this.clearFault(id, 'stuck message parked to DLQ'); effect = 'fixed'; }
        else message = 'No stuck offset found on any partition. Nothing parked.';
        break;
      case 'tune_consumer_timeout':
        if (f === 'rebalance_storm') { message = 'session.timeout.ms raised to 45000; group rejoined and stable.'; this.clearFault(id, 'consumer session timeout raised'); effect = 'fixed'; }
        else { message = 'Consumer group restarted with new timeout; brief pause while it rejoined.'; s.rebalances++; }
        break;
      case 'scale_out':
        if (f === 'instances_lost') { s.configured += 1; s.instances = s.configured; message = `Rescheduled on healthy nodes; ${s.instances}/${s.configured} instances ready.`; this.clearFault(id, 'instances rescheduled'); effect = 'fixed'; }
        else { s.configured += 1; s.instances += 1; message = `Added one instance (${s.instances}/${s.configured} ready).` + (hf ? ' It runs on the same kind of host and shows the same problem.' : ' No change to the underlying problem.'); }
        this.log(id, 'INFO', message);
        break;
      case 'restart': {
        s.restartUntil = this.t + 180;
        const sessions = s.ups.filter(u => this.c[u].type === 'source');
        message = 'Rolling restart started: capacity halved for about 3 minutes.'
          + (sessions.length ? ` All ${sessions.length} participant sessions were disconnected and had to log on again.` : '')
          + (f === 'config_change' ? ' It starts with the same configuration and keeps timing out.' : '')
          + (f === 'instances_lost' ? ' Evicted pods are still Pending — the nodes are the problem, not the process.' : '')
          + (hf === 'disk_full' ? ' The application starts, then fails again writing to a full disk.' : '')
          + (hf === 'memory_oom' ? ' It runs out of memory again within a minute.' : '')
          + (hf === 'fd_exhausted' ? ' It works briefly, then runs out of file descriptors again.' : '');
        if (hf === 'fd_exhausted') { /* the leak returns: fault stays */ }
        this.log(id, 'INFO', 'Rolling restart requested' + (sessions.length ? '; disconnecting all participant sessions' : ''));
        break;
      }
      case 'rollback_deployment':
        message = `No deployment to ${name} in the last 7 days. Nothing to roll back.` + (f === 'config_change' ? ` (Configuration was refreshed at ${clockStr(s.fault.since)}, commit ${s.fault.commit}; that is not a deployment.)` : '');
        break;
      case 'revert_config':
        if (f === 'config_change') { const api = s.fault.params.api; message = `Reverted commit ${s.fault.commit}: ${api} read timeout back to 2000 ms. Calls succeeding again.`; this.clearFault(id, 'configuration change reverted'); effect = 'fixed'; this.log(id, 'INFO', `Configuration refreshed (revert of ${'7c1e2a9'}): http.client.${api}.read-timeout-ms=2000`); }
        else message = `No configuration change to ${name} today. Nothing reverted.`;
        break;
      case 'enable_retry_backoff':
        s.backoff = true;
        if (f === 'api_rate_limited') { message = `Retries now back off exponentially with jitter. 429 responses stopped; throughput back within the ${fmtInt(s.fault.params.quota_per_min)}/min quota.`; this.clearFault(id, 'API retries switched to back-off'); effect = 'fixed'; }
        else message = 'Retry policy changed to exponential back-off. No calls were being throttled, so nothing changed.';
        break;
      case 'rotate_api_credentials':
        if (f === 'api_auth_expired') { message = `New client secret fetched from the vault; ${name} accepts our token again.`; this.clearFault(id, 'API client secret rotated'); effect = 'fixed'; }
        else message = 'Client secret rotated. The old one was still valid; no change.';
        break;
      case 'reprocess_rejected': {
        const n = Math.round(s.rejected);
        if (!n) { message = 'Exception queue is empty.'; break; }
        const still = this.rejectCauses(s).length > 0;
        message = still ? `Resubmitted ${fmtInt(n)} items — they will be rejected again until the data problem is fixed.` : `Resubmitted ${fmtInt(n)} items from the exception queue.`;
        s.retry += s.rejected; s.rejected = 0; effect = still ? 'none' : 'partial';
        break;
      }
      case 'increase_memory_limit':
        if (hf === 'memory_oom') { message = `Memory limit raised to 12 GiB; ${name} redeployed and running stably.`; fixHost('memory limit raised'); }
        else message = `Memory limit raised and ${name} redeployed (capacity briefly halved). Memory was not the problem.`;
        if (hf !== 'memory_oom') s.restartUntil = this.t + 120;
        break;
      case 'raise_fd_limit':
        if (hf === 'fd_exhausted') { message = `Open-files limit raised from 4,096 to 65,536 and ${name} restarted.`; fixHost('open-files limit raised'); }
        else { message = `Open-files limit raised and ${name} restarted. Descriptors were not the problem.`; if (s.type === 'service') s.restartUntil = this.t + 120; else s.adapterDownUntil = this.t + 60; }
        break;
      case 'purge_queue': {
        let n = 0;
        if (s.type === 'kafka_topic') { n = s.parts.reduce((a, b) => a + b, 0); s.parts = s.parts.map(() => 0); if (f === 'poison_message') this.clearFault(id, 'partition purged (stuck message deleted with everything behind it)'); }
        else { n = s.inbox + (s.retry || 0); s.inbox = 0; if (s.retry) s.retry = 0; }
        this.biz.lost += n;
        message = `Purged ${fmtInt(n)} waiting messages. They are gone: every one of them now needs manual reconciliation.`;
        this.log(id, 'WARN', `Operator purged ${fmtInt(n)} messages`);
        break;
      }
      case 'clear_disk_space':
        if (hf === 'disk_full') { message = `Archived and removed old files on ${host}: ${mountOf(s)} down from 100% to 46%. ${s.type === 'database' ? (isPg(s) ? 'WAL writes succeeding; the database accepts writes again.' : 'Archiver resumed; commits flowing again.') : 'Writes succeeding again.'}`; fixHost(`${mountOf(s)} cleared`); }
        else message = `Cleared old files on ${host}; disk was already at ${Math.round(s.host.disk)}%. No change.`;
        break;
      case 'kill_runaway_process':
        if (hf === 'cpu_runaway') { message = `Killed backup_agent (PID 7731) using 98% CPU on ${host}. CPU back to normal; reschedule the backup outside trading hours.`; fixHost('runaway backup job killed'); }
        else message = `No runaway process found on ${host}; top shows only the application.`;
        break;
      case 'resync_ntp':
        if (hf === 'clock_skew') { message = `chronyd restarted; clock stepped by ${s.host.fault.params.seconds}s and now in sync. Participants can log on again.`; fixHost('host clock resynchronised'); }
        else message = `NTP resync on ${host}: offset was already under 1 ms. No change.`;
        break;
      case 'restart_host':
        s.host.outageUntil = this.t + 240;
        message = `${host} rebooting: ${name} is unavailable for about 4 minutes.`;
        if (hf === 'clock_skew' || hf === 'cpu_runaway') { message += ' The reboot also cleared the host problem.'; fixHost('host rebooted'); }
        else if (hf) message += ' The problem returns once it is back up.';
        break;
      case 'failover_to_dr':
        s.host.outageUntil = this.t + 300;
        message = `Failing ${name} over to the DR site: unavailable for about 5 minutes while it switches.`;
        if (hf === 'cert_expired') message += ' The DR adapter uses the same expired client certificate.';
        else if (hf) { message += ' The DR host does not have the problem.'; fixHost('failed over to DR'); }
        if (f === 'api_rate_limited' || f === 'api_auth_expired') message += ' The API still rejects calls from DR.';
        if (s.type === 'external_party' && f === 'unavailable') message += ' The external party is still down, so DR does not help.';
        break;
      case 'renew_certificate':
        if (hf === 'cert_expired') { message = `Renewed client certificate installed (valid to 2027-10-08); TLS handshake with ${name} succeeds.`; fixHost('client certificate renewed'); }
        else message = `Certificate renewed; the old one was valid for another 214 days. No change.`;
        break;
      case 'escalate_to_vendor':
        if (f === 'unavailable') { s.recoverAt = this.t + (A.delay_min || 8) * 60; message = `P1 raised with ${name}. They confirm an outage on their side; ETA about ${A.delay_min || 8} minutes.`; effect = 'pending'; }
        else if (f === 'api_rate_limited') message = `${name} reports your adapter exceeds its ${fmtInt(s.fault.params.quota_per_min)} calls/min quota, mostly immediate retries of throttled calls. They will not raise the quota today.`;
        else if (f === 'api_auth_expired') message = `${name} reports no issues. Your calls are rejected because your API client secret expired at 00:00 today, as notified last month.`;
        else if (hf === 'cert_expired') message = `${name} reports no issues on their platform. They see TLS handshakes from your adapter failing because your client certificate has expired.`;
        else if (hf === 'disk_full' || hf === 'fd_exhausted') message = `${name} reports no issues and no recent traffic from you. The problem is on your side of the connection.`;
        else message = `${name} reports no issues on their platform.`;
        break;
      case 'restart_adapter':
        s.adapterDownUntil = this.t + 60;
        message = 'Adapter restarted (1 minute without connectivity).' + (f === 'unavailable' ? ' Calls still fail: the external platform itself is down.' : f === 'api_rate_limited' ? ' On reconnect it replayed its queue at full speed and was throttled harder.' : f === 'api_auth_expired' ? ' It reloads the same expired secret: still 401.' : hf === 'cert_expired' ? ' The TLS handshake still fails after the restart.' : hf === 'disk_full' ? ' It still cannot spool messages: the disk is full.' : '');
        break;
      case 'force_refresh': {
        const missed = this.issuersOf(id).filter(is => is.fault && is.fault.type === 'announcement_missed');
        if (hf === 'disk_full') { message = 'Load failed again: No space left on device.'; break; }
        s.lastRefresh = this.t; s.records += 12;
        missed.forEach(is => this.clearFault(is.def.id, 'corporate action applied during full reload'));
        if (f === 'feed_failed') { message = `Loaded ${fmtInt(s.records)} records from the secondary source. Rejections should stop; anything already rejected needs reprocessing.`; this.clearFault(id, 'feed re-run from secondary source'); effect = 'fixed'; }
        else if (missed.length) { message = `Full reload done, including pending corporate action files (${missed.map(m => m.def.name).join(', ')}).`; effect = 'fixed'; }
        else message = `Refreshed: ${fmtInt(s.records)} records (no change).`;
        this.log(id, 'INFO', `${name} loaded: ${fmtInt(s.records)} records (manual refresh)`);
        break;
      }
      case 'reload_announcement':
        if (f === 'announcement_missed') { message = `Corporate action ${s.fault.ca} for ${name} reprocessed with the corrected ISIN; price bands updated.`; this.clearFault(id, 'corporate action reprocessed'); effect = 'fixed'; }
        else message = `No pending corporate actions for ${name}.`;
        break;
      case 'kill_blocking_session':
        if (f === 'pool_exhausted') { message = 'Killed session 482 (month_end_recon_report). Connections released.'; this.log(id, 'INFO', 'Session 482 killed by operator; pool recovering'); this.clearFault(id, 'blocking session killed'); effect = 'fixed'; }
        else if (hf === 'disk_full') message = isPg(s) ? 'No blocking sessions. Sessions are waiting on WAL writes (IO: WALWrite).' : 'No blocking sessions. Sessions are waiting on “log file switch (archiving needed)”.';
        else message = 'No blocking sessions found.';
        break;
      case 'increase_pool_size':
        message = f === 'pool_exhausted' ? `Pool raised to ${s.def.pool_size + 30}. The long-running query is still running and the new connections fill up too.` : hf === 'disk_full' ? 'Pool raised. New connections wait on the archiver like the others.' : 'Pool raised. It was not the bottleneck.';
        break;
    }
    if (effect === 'none' && A.fixes && (A.fixes.includes(f) || A.fixes.includes(hf))) effect = 'fixed';
    this.events.push({ t: this.t, kind: 'action', text: `${A.label} on ${name}: ${message}` });
    return { ok: true, message, effect, label: A.label };
  };

  Simulator.prototype.activeFaults = function () {
    const out = [];
    Object.values(this.c).forEach(s => {
      if (s.fault) out.push({ id: s.def.id, type: s.fault.type });
      if (s.host && s.host.fault) out.push({ id: s.def.id, type: s.host.fault.type, host: true });
      if (s.host && this.inOutage(s)) out.push({ id: s.def.id, type: 'outage', host: true });
    });
    return out;
  };
  Simulator.prototype.pendingRepair = function () {
    let rejected = 0, held = 0;
    Object.values(this.c).forEach(s => { if (s.type === 'service') rejected += s.rejected; if (s.type === 'source') held += s.held; });
    return { rejected, held, lost: this.biz.lost };
  };

  const OpsSim = { TYPES, HOST_TYPES, HOST_FAULTS, MOUNT, mountOf, isPg, ACTIONS, CAUSES, faultsFor, actionsFor, causeLabel, hasHost, parseBlueprint, validateBlueprint, Simulator, clockStr, parseClock, fmtInt, rng };
  if (typeof module === 'object' && module.exports) module.exports = OpsSim;
  else root.OpsSim = OpsSim;
})(typeof globalThis !== 'undefined' ? globalThis : this);
