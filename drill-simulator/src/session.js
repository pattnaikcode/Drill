/*
 * OpsPilot Drill Simulator — drill session.
 *
 * A drill = a blueprint + scheduled faults + the correct answer + scoring rules.
 * The session never tells the responder what is wrong; it only records what they do
 * (acknowledge, inspect, declare a root cause, request approved actions) and scores it.
 */
(function (root) {
  'use strict';
  const S = (typeof module === 'object' && module.exports) ? require('./engine.js') : root.OpsSim;

  // problems with one scenario (a normal drill is one scenario; a mystery drill has a pool)
  function scenarioErrors(sc, bp, where) {
    const errors = [];
    (sc.faults || []).forEach(f => {
      const c = bp.byId[f.component];
      if (!c) { errors.push(`${where}: needs component "${f.component}", which this system does not have.`); return; }
      if (!S.TYPES[c.type].faults[f.fault]) errors.push(`${where}: ${c.type} "${f.component}" has no fault "${f.fault}".`);
      if (S.parseClock(f.at) === null) errors.push(`${where}: fault time "${f.at}" must look like "13:36".`);
    });
    if (!(sc.faults || []).length) errors.push(`${where}: needs at least one fault.`);
    [...(sc.accepted_fixes || []), ...(sc.risky_actions || [])].forEach(a => {
      const [cid, act] = String(a).split('.');
      const c = bp.byId[cid];
      if (!c) errors.push(`${where}: action "${a}" refers to missing component "${cid}".`);
      else if (!S.TYPES[c.type].actions[act]) errors.push(`${where}: ${c.type} "${cid}" has no action "${act}".`);
    });
    if (sc.root_cause && (!bp.byId[sc.root_cause.component] || !S.TYPES[bp.byId[sc.root_cause.component].type].faults[sc.root_cause.fault]))
      errors.push(`${where}: root_cause must name a component of this system and one of its faults.`);
    if ((sc.faults || []).some(f => bp.start !== undefined && S.parseClock(f.at) !== null && (S.parseClock(f.at) < bp.start || S.parseClock(f.at) >= bp.cutoff)))
      errors.push(`${where}: fault times must fall between this system's start (${S.clockStr(bp.start)}) and cut-off (${S.clockStr(bp.cutoff)}).`);
    return errors;
  }
  function validateDrill(drill, bp) {
    if (!drill || !drill.id || !drill.title) return ['A use case needs an "id" and a "title".'];
    if (!drill.mystery) return scenarioErrors(drill, bp, 'drill');
    const pool = drill.pool || [];
    if (!pool.length) return ['Mystery drill needs a "pool" of scenarios.'];
    const errs = pool.map((sc, i) => scenarioErrors(sc, bp, `pool[${i}]`));
    return errs.some(e => !e.length) ? [] : errs[0]; // usable if at least one scenario fits this system
  }
  // which systems a drill is meant for: listed in "systems", or any system it fits
  function drillFor(drill, bp) { return Array.isArray(drill.systems) ? drill.systems.includes(bp.id) : !validateDrill(drill, bp).length; }

  function Session(sim, drill, opts) {
    opts = opts || {};
    this.sim = sim; this.drill = drill; this.mode = opts.mode || 'practice';
    const usable = drill.mystery ? drill.pool.filter(sc => !scenarioErrors(sc, sim.bp, '').length) : [drill];
    const pick = drill.mystery ? usable[Math.floor(S.rng(opts.seed || Date.now())() * usable.length)] : drill;
    this.sc = pick; // the scenario actually running (for mystery drills, hidden from the responder)
    this.state = 'running';
    this.faultPlan = (pick.faults || []).map(f => ({ ...f, t: S.parseClock(f.at), done: false }));
    this.noisePlan = (drill.noise || []).map(n => ({ ...n, t: S.parseClock(n.at), done: false }));
    this.faultAt = Math.min(...this.faultPlan.map(f => f.t));
    this.lastFaultAt = Math.max(...this.faultPlan.map(f => f.t));
    this.timeline = [{ t: sim.t, kind: 'start', text: `Drill started: ${drill.title} (${this.mode} mode)` }];
    this.ackAt = null; this.ackBy = null;
    this.declarations = []; this.actions = []; this.inspected = new Set();
    this.noiseIds = new Set();
    this.recoveredAt = null; this.endedAt = null; this.cutoffResult = null;
    this.hintsShown = 0;
  }

  Session.prototype.tick = function (dt) {
    if (this.state !== 'running') return;
    const sim = this.sim;
    sim.step(dt);
    this.faultPlan.forEach(f => { if (!f.done && sim.t >= f.t) { f.done = true; sim.injectFault(f.component, f.fault, f.params); } });
    this.noisePlan.forEach(n => {
      if (!n.done && sim.t >= n.t) { n.done = true; const a = sim.addExternalAlert({ name: n.name, severity: n.severity || 'P4', on: n.on || 'infra' }); this.noiseIds.add(a.id); }
    });
    // recovered: every fault fixed, exception queues empty, business back within normal in-flight volume
    const allInjected = this.faultPlan.every(f => f.done);
    if (allInjected && sim.t > this.lastFaultAt + 60 && !sim.activeFaults().length && sim.pendingRepair().rejected < 1 && sim.pendingRepair().held < 1) {
      const k = sim.cutoffKpi();
      if (!k || k.trades <= sim.bp.business.tolerance_trades) {
        this.recoveredAt = sim.t;
        this.timeline.push({ t: sim.t, kind: 'recovered', text: 'Business flow back to normal' });
        this.finish('recovered');
        return;
      }
    }
    if (sim.t >= sim.bp.cutoff) {
      const k = sim.cutoffKpi();
      this.cutoffResult = k;
      this.timeline.push({ t: sim.t, kind: 'cutoff', text: `${sim.bp.clockLabel} reached. ${k ? k.label + ': ' + S.fmtInt(k.trades) + ' ' + sim.bp.business.unit_name : ''}` });
      this.finish('cutoff');
    }
  };

  Session.prototype.finish = function (why) {
    this.state = 'ended'; this.endReason = why; this.endedAt = this.sim.t;
    if (why === 'abandoned') this.timeline.push({ t: this.sim.t, kind: 'end', text: 'Drill ended by responder' });
  };

  Session.prototype.realAlerts = function () { return this.sim.alerts.filter(a => !this.noiseIds.has(a.id) && a.firedAt >= this.faultAt); };
  Session.prototype.firstAlertAt = function () { const a = this.realAlerts(); return a.length ? Math.min(...a.map(x => x.firedAt)) : null; };

  Session.prototype.acknowledge = function (who) {
    if (this.ackAt !== null || this.state !== 'running') return false;
    this.ackAt = this.sim.t; this.ackBy = who || 'Responder';
    this.timeline.push({ t: this.sim.t, kind: 'ack', text: `Acknowledged by ${this.ackBy}` });
    return true;
  };

  Session.prototype.inspect = function (id) {
    if (this.inspected.has(id) || this.state !== 'running') return;
    this.inspected.add(id);
    this.timeline.push({ t: this.sim.t, kind: 'inspect', text: `Inspected ${this.sim.c[id].def.name}` });
  };

  Session.prototype.declare = function (component, fault) {
    if (this.state !== 'running') return null;
    const rc = this.sc.root_cause || { component: this.faultPlan[0].component, fault: this.faultPlan[0].fault };
    const correct = rc.component === component && rc.fault === fault;
    const c = this.sim.c[component];
    const label = c ? `${S.TYPES[c.type].faults[fault] ? S.TYPES[c.type].faults[fault].label : fault} on ${c.def.name}` : fault;
    this.declarations.push({ t: this.sim.t, component, fault, correct, label });
    this.timeline.push({ t: this.sim.t, kind: 'declare', text: `Declared root cause: ${label}` });
    return correct; // stored for the debrief; the UI does not reveal it during the drill
  };

  Session.prototype.requestAction = function (component, action, approver, confirmed) {
    if (this.state !== 'running') return { ok: false, message: 'The drill has ended.' };
    if (!approver || !String(approver).trim()) return { ok: false, message: 'An approver name is required.' };
    if (!confirmed) return { ok: false, message: 'The approver must confirm the action.' };
    const r = this.sim.applyAction(component, action);
    if (!r.ok) return r;
    const key = component + '.' + action;
    const accepted = (this.sc.accepted_fixes || []).includes(key);
    const risky = (this.sc.risky_actions || []).includes(key);
    const cls = accepted ? 'accepted' : risky ? 'risky' : 'unnecessary';
    this.actions.push({ t: this.sim.t, key, label: r.label, component, approver: approver.trim(), cls, message: r.message });
    this.timeline.push({ t: this.sim.t, kind: 'action', text: `${r.label} on ${this.sim.c[component].def.name} (approved by ${approver.trim()}): ${r.message}` });
    return r;
  };

  // investigation tools used (Grafana, Splunk, SQL, shell): recorded for the debrief
  Session.prototype.useTool = function (tool, detail) {
    if (this.state !== 'running') return;
    this.toolUse = this.toolUse || [];
    const last = this.toolUse[this.toolUse.length - 1];
    if (last && last.tool === tool && last.detail === detail) return;
    this.toolUse.push({ t: this.sim.t, tool, detail });
    this.timeline.push({ t: this.sim.t, kind: 'tool', text: `${tool}: ${detail}` });
  };

  Session.prototype.visibleHints = function () {
    if (this.mode !== 'practice') return [];
    const mins = (this.sim.t - this.faultAt) / 60;
    return (this.sc.hints || []).filter(h => mins >= (h.after_min || 0)).map(h => h.text);
  };

  Session.prototype.score = function () {
    const sim = this.sim, min = x => x === null || x === undefined ? null : Math.round(x / 60);
    const first = this.firstAlertAt();
    const parts = [];
    // 1. detection + acknowledgement
    let ackPts = 0, mtta = null;
    if (this.ackAt !== null) {
      mtta = first === null ? 0 : Math.max(0, this.ackAt - first);
      ackPts = mtta <= 300 ? 15 : mtta <= 600 ? 10 : mtta <= 1200 ? 5 : 2;
    }
    parts.push({ label: 'Acknowledged promptly', pts: ackPts, max: 15, note: this.ackAt === null ? 'Never acknowledged' : (first === null ? 'Acknowledged before any alert' : `MTTA ${min(mtta)} min after first real alert`) });
    // 2. diagnosis
    const firstCorrect = this.declarations.findIndex(d => d.correct);
    const diagPts = firstCorrect === 0 ? 30 : firstCorrect === 1 ? 15 : firstCorrect > 1 ? 5 : 0;
    parts.push({ label: 'Correct root cause', pts: diagPts, max: 30, note: !this.declarations.length ? 'No root cause declared' : firstCorrect < 0 ? 'Root cause not identified' : `Correct on attempt ${firstCorrect + 1}, ${min(this.declarations[firstCorrect].t - this.faultAt)} min after fault` });
    // 3. fix
    const fixed = !sim.activeFaults().length;
    const usedFix = this.actions.some(a => a.cls === 'accepted');
    const fixPts = fixed && usedFix ? 25 : usedFix ? 15 : 0;
    parts.push({ label: 'Applied the right fix', pts: fixPts, max: 25, note: fixed && usedFix ? 'Fault resolved with an accepted action' : usedFix ? 'Right action taken, recovery still in progress' : 'Fault not fixed by an accepted action' });
    // 4. business outcome
    const tol = sim.bp.business.tolerance_trades;
    let bizPts = 0, bizNote;
    if (this.recoveredAt !== null) { bizPts = 20; bizNote = `Business flow normal at ${S.clockStr(this.recoveredAt)}, before the ${S.clockStr(sim.bp.cutoff)} ${sim.bp.clockLabel.toLowerCase()}`; }
    else if (this.cutoffResult) {
      const k = this.cutoffResult;
      bizPts = k.trades <= tol ? 20 : k.trades <= tol * 3 ? 10 : 0;
      bizNote = `${k.label} at cut-off: ${S.fmtInt(k.trades)} ${sim.bp.business.unit_name} (${sim.bp.business.currency}${S.fmtInt(k.notional)} ${sim.bp.business.unit})`;
    } else bizNote = 'Drill ended before recovery or cut-off';
    parts.push({ label: 'Met the business deadline', pts: bizPts, max: 20, note: bizNote });
    // 5. safe operations
    const risky = this.actions.filter(a => a.cls === 'risky').length, unnec = this.actions.filter(a => a.cls === 'unnecessary').length;
    const safePts = Math.max(0, 10 - risky * 5 - unnec * 3);
    parts.push({ label: 'Safe operations', pts: safePts, max: 10, note: !risky && !unnec ? 'No risky or unnecessary actions' : `${risky} risky, ${unnec} unnecessary action(s)` });
    const total = parts.reduce((a, p) => a + p.pts, 0);
    return {
      total, parts, grade: total >= 85 ? 'Excellent' : total >= 65 ? 'Good' : total >= 40 ? 'Needs practice' : 'Not ready',
      times: {
        fault: this.faultAt, firstAlert: first, ack: this.ackAt,
        detect: first === null ? null : min(first - this.faultAt), mtta: min(mtta),
        diagnose: firstCorrect >= 0 ? min(this.declarations[firstCorrect].t - this.faultAt) : null,
        recover: this.recoveredAt === null ? null : min(this.recoveredAt - this.faultAt),
      },
    };
  };

  Session.prototype.debrief = function () {
    const sim = this.sim;
    const hidden = sim.events.filter(e => e.kind === 'fault' || e.kind === 'fixed' || (e.kind === 'alert' && e.t >= this.faultAt - 60));
    const all = [...this.timeline, ...hidden.map(e => ({ t: e.t, kind: e.kind, text: e.text }))].sort((a, b) => a.t - b.t);
    const rc = this.sc.root_cause || { component: this.faultPlan[0].component, fault: this.faultPlan[0].fault };
    const c = sim.c[rc.component];
    return {
      score: this.score(), timeline: all,
      answer: { component: c.def.name, fault: S.TYPES[c.type].faults[rc.fault].label },
      accepted: (this.sc.accepted_fixes || []).map(k => { const [cid, a] = k.split('.'); return `${S.TYPES[sim.c[cid].type].actions[a].label} on ${sim.c[cid].def.name}`; }),
      notes: this.sc.debrief || {}, actions: this.actions, declarations: this.declarations,
      inspected: [...this.inspected].map(id => sim.c[id].def.name), tools: this.toolUse || [],
    };
  };

  const OpsDrill = { Session, validateDrill, drillFor };
  if (typeof module === 'object' && module.exports) module.exports = OpsDrill;
  else root.OpsDrill = OpsDrill;
})(typeof globalThis !== 'undefined' ? globalThis : this);
