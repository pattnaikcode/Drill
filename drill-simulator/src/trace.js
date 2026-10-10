/*
 * OpsPilot Drill Simulator — traced orders ("follow an order").
 *
 * The main engine moves counts (2,000 orders a minute). This module follows ONE order through the
 * same live graph, hop by hop, using the journey written in the system's YAML:
 *
 *   journeys:
 *     - id: filled
 *       name: Buy order fully filled
 *       order: {member: broker_a, symbol: KONSTL, side: BUY, qty: 100, price: 1203.40}
 *       steps:
 *         - {at: fix_gateway, does: "...", message: "...", writes: ["orders: insert status=NEW"]}
 *
 * Each hop takes as long as the real queue and processing time at that component. If a fault is
 * active where the order is, it waits there (with the reason a support engineer would find) or is
 * rejected, exactly like the bulk traffic. Table writes become rows you can query in the SQL console.
 */
(function (root) {
  'use strict';
  const S = (typeof module === 'object' && module.exports) ? require('./engine.js') : root.OpsSim;
  const P = S.Simulator.prototype;
  const pad = (n, w) => String(n).padStart(w, '0');
  const hash = s => [...String(s)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);

  // time with milliseconds: 14:36:05.213
  function stamp(t) { const ms = Math.round((t % 1) * 1000) % 1000; return S.clockStr(Math.floor(t), true) + '.' + pad(ms, 3); }

  // fill {placeholders} from the order's fields
  const fill = (text, v) => String(text == null ? '' : text).replace(/\{(\w+)\}/g, (m, k) => (v[k] === undefined ? m : k === 'price' && typeof v[k] === 'number' ? v[k].toFixed(2) : v[k]));

  P._traceInit = function () {
    if (this.traces) return;
    this.traces = []; this.traceSeq = 0;
    this.traceTables = {};
    Object.entries(this.bp.tables || {}).forEach(([name, d]) => { this.traceTables[name] = { db: d.db, columns: d.columns.slice(), rows: [] }; });
  };

  // send one order along a journey; returns the trace
  P.sendOrder = function (journeyId, overrides) {
    this._traceInit();
    const j = (this.bp.journeys || []).find(x => x.id === journeyId);
    if (!j) throw new Error(`No journey "${journeyId}"`);
    const n = ++this.traceSeq;
    const vars = {
      ...j.order, ...(overrides || {}),
      order_id: `EX${pad(26100 + Math.floor(this.t / 60) % 900, 5)}${pad(n, 3)}`,
      clordid: `CL-${pad(n * 7919 % 100000, 5)}`,
      trade_id: `TR${pad(55000 + n * 13, 6)}`,
      exec_id: `E${pad(880000 + n * 31, 7)}`,
      seq: 10400 + (n * 37) % 600,                                                  // FIX MsgSeqNum (34)
      sending_time: `20261009-${S.clockStr(Math.floor(this.t), true)}.000`, // stamped by the broker as it sends // FIX SendingTime (52)
    };
    // resolve "role:Broker" steps and order fields to real components, so new members appear in journeys
    const byRole = role => this.bp.components.filter(c => c.role === role);
    const steps = j.steps.map(st => ({ ...st }));
    const resolved = {}; // original "at" text -> chosen id
    steps.forEach((st, i) => {
      if (!/^role:/.test(String(st.at))) return;
      if (resolved[st.at]) { st.at = resolved[st.at]; return; }
      const next = steps[i + 1] && !/^role:/.test(String(steps[i + 1].at)) ? steps[i + 1].at : null;
      const pool = byRole(String(st.at).slice(5).trim()).filter(c => !next || this.bp.edges.some(([a, b]) => a === c.id && b === next));
      const c = pool[Math.floor(this.rand() * pool.length)];
      resolved[st.at] = c.id; st.at = c.id;
      if (i === 0) Object.assign(vars, { participant: c.name, session: c.session || c.id.toUpperCase(), member: vars.member && !/^role:/.test(vars.member) ? vars.member : (c.session || c.id.toUpperCase()) });
    });
    steps.forEach(st => { if (st.from && resolved[st.from]) st.from = resolved[st.from]; });
    Object.entries(j.order || {}).forEach(([k, val]) => {
      if (!/^role:/.test(String(val)) || k === 'member') return;
      const pool = byRole(String(val).slice(5).trim()); if (!pool.length) return;
      const c = pool[Math.floor(this.rand() * pool.length)];
      vars[k] = c.session || c.id.toUpperCase(); vars[k + '_name'] = c.name;
    });
    const tr = { id: 'TRACE-' + n, journey: j, steps, vars, step: 0, clock: this.t, sentAt: this.t, status: 'moving', reason: null, waitSince: null, where: steps[0].at, done: [], blocked: {}, transit: {} };
    this.traces.unshift(tr);
    if (this.traces.length > 20) this.traces.pop();
    return tr;
  };

  // what is in the way of this order at this component right now
  P._hop = function (tr, st) {
    const s = this.c[st.at], hf = this.hostFault(s), v = tr.vars;
    const out = { wait: null, reject: null, delay: 0.002, note: null };
    if (s.type === 'source') {
      if (st.reject) { out.reject = fill(st.reject, v); return out; } // e.g. the broker's own risk system blocks the order
      const why = this.sourceDown(s);
      if (why === 'seq') out.wait = `Session ${this.sessionId(s)} is not logged on (logon rejected: MsgSeqNum too low). The order is queued at the member.`;
      if (why === 'clock') out.wait = `Session ${this.sessionId(s)} is not logged on (logon rejected: SendingTime accuracy problem). The order is queued at the member.`;
      if (why === 'pack') out.wait = this.packText(s, s.fault.pack.reason || s.fault.pack.effect.reason || s.fault.pack.label);
      return out;
    }
    if (s.type === 'service') {
      if (st.reject) { out.reject = fill(st.reject, v); return out; }
      const f = this.serviceFactor(s);
      if (f < 0.02) {
        const db = (s.def.uses || []).map(u => this.c[u]).find(d => d.type === 'database' && this.dbFactor(d) < 0.05);
        if (this.inOutage(s)) out.wait = `${s.def.name} is unavailable: its host is restarting or failing over.`;
        else if (s.fault && s.fault.pack) out.wait = this.packText(s, s.fault.pack.effect.reason || s.fault.pack.label);
        else if (hf === 'disk_full') out.wait = `${s.def.name} cannot write: No space left on device (${S.mountOf(s)}).`;
        else if (hf === 'memory_oom') out.wait = `${s.def.name} is down between crash-loop restarts (OOMKilled).`;
        else if (db) out.wait = `${s.def.name} is waiting on ${db.def.name}: ${this.hostFault(db) === 'disk_full' ? 'commits hang (archive destination full)' : 'no free connection in the pool'}.`;
        else out.wait = `${s.def.name} is not processing (no healthy instances).`;
        return out;
      }
      // rejects caused by data problems: a missed corporate action on this symbol, or stale reference data
      for (const c of this.rejectCauses(s)) {
        if (c.kind === 'issuer' && (c.issuer.def.symbol || c.issuer.def.id.toUpperCase()) === v.symbol) { out.reject = `Price ${typeof v.price === 'number' ? v.price.toFixed(2) : v.price} outside band for ${v.symbol}: band not updated for ${c.issuer.fault.ca}`; return out; }
        if (c.kind === 'pack' && this.rand() < c.share * 2) { out.reject = this.packText(c.ref, c.msg).replace('{key}', v.order_id); return out; }
        if (c.kind === 'stale' && this.rand() < c.share * 3) { out.reject = c.ref.def.missing_msg ? fill(c.ref.def.missing_msg, { key: v.order_id }) : `Reference data in ${c.ref.def.name} is stale; rejected`; return out; }
      }
      if (!this.kafkaIn(s)) {
        const perSec = Math.max(0.01, s.def.capacity_per_min * f / 60), q = this.metric(st.at, 'backlog');
        out.delay = q / perSec + this.metric(st.at, 'latency_ms') / 1000 * 0.02;
        if (q / perSec > 2) out.note = `waited in queue behind ${S.fmtInt(q)} messages`;
      } else out.delay = 0.003;
      if (s.fault && s.fault.type === 'config_change') { out.delay += 0.15; out.note = `${s.fault.params.api} timed out twice (${s.fault.params.timeout_ms} ms); succeeded on retry`; }
      if (hf === 'cpu_runaway' || hf === 'fd_exhausted') { out.delay *= 3; out.note = (out.note ? out.note + '; ' : '') + 'slow: host under pressure'; }
      return out;
    }
    if (s.type === 'kafka_topic') {
      const p = hash(v.symbol || v.order_id) % s.parts.length; // keyed by symbol: same symbol, same partition
      v.partition = p;
      if (s.blocked === p) { out.wait = `Stuck in ${s.def.name} partition ${p}: the consumer keeps failing on the message at offset ${Math.floor(s.stuckOffset)} ahead of it.`; return out; }
      const cons = s.assign ? Object.keys(s.assign).find(k => this.partitionsOf(s, k).includes(p)) : s.downs[0];
      const c = this.c[cons], f = c ? this.serviceFactor(c) : 1;
      const active = Math.max(1, this.partitionsOf(s, cons).filter(i => s.parts[i] > 1).length);
      const perSec = Math.max(0.01, (c ? c.def.capacity_per_min : 1000) * f / 60 / active);
      if (f < 0.02) { out.wait = `Waiting in ${s.def.name} partition ${p}: its consumer ${c ? c.def.name : ''} is not consuming.`; return out; }
      out.delay = s.parts[p] / perSec + 0.004;
      if (s.parts[p] / perSec > 2) out.note = `waited behind ${S.fmtInt(s.parts[p])} messages of lag on partition ${p}`;
      if (s.fault && s.fault.type === 'rebalance_storm') { out.delay += 8; out.note = 'consumer group rebalancing; partitions revoked and reassigned'; }
      return out;
    }
    if (s.type === 'external_party') {
      const why = this.extDown(s);
      const R = { pack: s.fault && s.fault.pack ? this.packText(s, s.fault.pack.effect.reason || s.fault.pack.label) : '', vendor: `${s.def.name} returns 503 Service Unavailable (their outage).`, auth: `${s.def.name} returns 401 Unauthorized: our API client secret has expired.`, cert: `TLS handshake with ${s.def.name} fails: our client certificate has expired.`, disk: `Our adapter cannot spool the message: No space left on device.`, restart: `Our adapter for ${s.def.name} is restarting.` };
      if (why) { out.wait = R[why]; return out; }
      const perSec = Math.max(0.01, s.def.capacity_per_min * (s.fault && s.fault.type === 'api_rate_limited' ? 0.35 : 1) / 60);
      out.delay = s.inbox / perSec + 0.02;
      if (s.fault && s.fault.type === 'api_rate_limited') out.note = 'throttled: 429 Too Many Requests, retried';
      else if (s.inbox / perSec > 2) out.note = `waited behind ${S.fmtInt(s.inbox)} messages`;
      return out;
    }
    return out;
  };

  // apply "orders: insert status=NEW" / "orders: update status=FILLED filled_qty={qty}"
  P._traceWrite = function (tr, spec) {
    const m = /^(\w+)\s*:\s*(insert|update)\b\s*(.*)$/i.exec(spec); if (!m) return null;
    const tbl = this.traceTables[m[1]]; if (!tbl) return null;
    const set = {};
    (m[3].match(/(\w+)=("[^"]*"|\S+)/g) || []).forEach(kv => {
      const i = kv.indexOf('='), raw = kv.slice(i + 1), quoted = /^".*"$/.test(raw), val = fill(raw.replace(/^"|"$/g, ''), tr.vars);
      set[kv.slice(0, i)] = !quoted && /^-?\d+(\.\d+)?$/.test(val) ? Number(val) : val; // numbers stay numbers, so SQL can compare them
    });
    const now = stamp(tr.clock);
    if (m[2].toLowerCase() === 'insert') {
      const row = {};
      tbl.columns.forEach(c => { row[c] = set[c] !== undefined ? set[c] : tr.vars[c] !== undefined ? tr.vars[c] : (/(_at|time)$/.test(c) ? now : null); });
      tbl.rows.unshift(row);
      if (tbl.rows.length > 200) tbl.rows.pop();
      return `${m[1]}: INSERT ${Object.entries(set).map(([k, x]) => `${k}=${x}`).join(' ')}`.trim();
    }
    const key = tbl.columns.find(c => tr.vars[c] !== undefined && /_id$/.test(c)) || tbl.columns[0];
    tbl.rows.filter(r => String(r[key]) === String(tr.vars[key])).forEach(r => { Object.assign(r, set); tbl.columns.forEach(c => { if (/^(updated_at|last_update)$/.test(c)) r[c] = now; }); });
    return `${m[1]}: UPDATE ${Object.entries(set).map(([k, x]) => `${k}=${x}`).join(' ')} WHERE ${key}=${tr.vars[key]}`;
  };

  // a step follows the previous step, or the step named in "from" (a branch, e.g. the same trade to clearing and to surveillance)
  function parentOf(steps, i) {
    const st = steps[i];
    if (st.from === undefined) return i - 1;
    for (let k = i - 1; k >= 0; k--) if (steps[k].at === st.from) return k;
    return i - 1;
  }

  P._advanceTraces = function () {
    if (!this.traces) return;
    this.traces.forEach(tr => {
      if (tr.status === 'done' || tr.status === 'rejected') return;
      const steps = tr.steps;
      tr.eta = tr.eta || {}; tr.waits = tr.waits || {};
      const blocked = {}, transit = {};
      for (let pass = 0, moved = true; moved && pass < 40; pass++) {
        moved = false;
        for (let i = 0; i < steps.length; i++) {
          if (tr.done[i] || tr.status === 'rejected') continue;
          const pi = parentOf(steps, i);
          if (pi >= 0 && !tr.done[pi]) continue;
          const st = steps[i], h = this._hop(tr, st);
          if (h.wait) { blocked[i] = h.wait; if (tr.waits[i] === undefined) tr.waits[i] = this.t; delete tr.eta[i]; continue; }
          if (tr.eta[i] === undefined) { // arrival time here: after the parent step, or now if it had to wait
            const base = tr.waits[i] !== undefined ? this.t : (pi >= 0 ? tr.done[pi].t : tr.sentAt);
            tr.eta[i] = { t: base + h.delay, note: h.note };
          }
          if (tr.eta[i].t > this.t) { transit[i] = tr.eta[i].note; continue; } // still queued or in transit
          const t = tr.eta[i].t, waited = tr.waits[i] !== undefined ? this.t - tr.waits[i] : 0;
          tr.clock = t;
          if (this.c[st.at].type === 'kafka_topic') tr.vars.offset = Math.floor(this.c[st.at].offsets[tr.vars.partition]);
          if (h.reject) {
            const writes = (st.on_reject && st.on_reject.writes) || (this.traceTables.orders ? [`orders: update status=REJECTED reject_reason="${h.reject}"`] : []);
            tr.done[i] = { t, at: st.at, does: `Rejected: ${h.reject}`, message: fill(st.reject_message || '', tr.vars), writes: writes.map(x => this._traceWrite(tr, x)).filter(Boolean), rejected: true, waited };
            tr.status = 'rejected'; tr.reason = h.reject; tr.where = st.at;
            this.log(st.at, 'WARN', `Order ${tr.vars.order_id} (${tr.vars.symbol}) rejected: ${h.reject}`);
            return;
          }
          tr.done[i] = { t, at: st.at, does: fill(st.does, tr.vars), message: fill(st.message, tr.vars), writes: (st.writes || []).map(x => this._traceWrite(tr, x)).filter(Boolean), note: tr.eta[i].note, waited };
          moved = true;
        }
      }
      tr.blocked = blocked; tr.transit = transit;
      tr.step = steps.findIndex((_, i) => !tr.done[i]); // first unfinished step (-1 when all done)
      const b = Object.keys(blocked)[0];
      if (tr.step < 0) { tr.status = 'done'; tr.reason = null; tr.where = null; tr.step = steps.length; }
      else if (b !== undefined) { tr.status = 'waiting'; tr.reason = blocked[b]; tr.where = steps[b].at; tr.waitSince = tr.waits[b]; }
      else { const k = Object.keys(transit)[0]; tr.status = 'moving'; tr.reason = k !== undefined ? transit[k] : null; tr.where = k !== undefined ? steps[k].at : steps[tr.step].at; tr.waitSince = null; }
    });
  };

  // rows for the SQL console: tables written by traced orders on this database
  P.traceTablesFor = function (dbId) {
    this._traceInit();
    return Object.entries(this.traceTables).filter(([, t]) => t.db === dbId);
  };
  P.traceStamp = stamp;

  const OpsTrace = { stamp };
  if (typeof module === 'object' && module.exports) module.exports = OpsTrace;
  else root.OpsTrace = OpsTrace;
})(typeof globalThis !== 'undefined' ? globalThis : this);
