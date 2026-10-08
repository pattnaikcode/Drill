/* OpsPilot Drill Simulator — user interface.
 * The engine (engine.js) and drill rules (session.js) hold all logic; this file only draws
 * state and turns clicks into calls on them. Static controls are built once per view; the
 * live parts (clock, map, alerts, inspector) refresh on every tick so typing is never lost.
 */
(function () {
  'use strict';
  const S = window.OpsSim, D = window.OpsDrill, yaml = window.jsyaml, C = window.DRILL_CONTENT;
  const $ = s => document.querySelector(s);
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = { get(k, d) { try { const v = localStorage.getItem('opsdrill.' + k); return v === null ? d : v; } catch (e) { return d; } }, set(k, v) { try { localStorage.setItem('opsdrill.' + k, v); } catch (e) { /* storage unavailable */ } } };

  const DRILLS = C.drills.map(t => yaml.load(t));
  const DRILL_TEXT = Object.fromEntries(C.drills.map((t, i) => [DRILLS[i].id, t]));
  const SIM_SECONDS_PER_REAL_SECOND = 10; // at 1× speed

  const A = {
    tab: 'drills', bpName: C.blueprints[C.default_blueprint] ? C.default_blueprint : Object.keys(C.blueprints)[0], bpText: '', bp: null, sim: null, session: null,
    drillId: DRILLS[0].id, mode: store.get('mode', 'practice'), responder: store.get('responder', ''),
    running: true, speed: 2, selected: null, approval: null, feed: [], acc: 0, debrief: null, errorsOnly: false,
    bpMsg: null, layout: null,
  };

  // ------------------------------------------------------------ blueprint + sim lifecycle
  function loadBlueprint(text) {
    const r = S.parseBlueprint(text, yaml);
    if (r.errors.length) return r.errors;
    A.bpText = text; A.bp = r.blueprint; A.session = null; A.feed = []; A.approval = null; A.ended = false;
    A.sim = new S.Simulator(A.bp, { seed: 7 });
    A.layout = layout(A.bp);
    A.selected = (A.bp.components.find(c => c.type === 'service') || A.bp.components[0]).id;
    if (DRILL_COMPAT(A.drillId).length) { const ok = DRILLS.find(d => !DRILL_COMPAT(d.id).length); if (ok) A.drillId = ok.id; }
    return [];
  }
  const DRILL_COMPAT = id => D.validateDrill(DRILLS.find(d => d.id === id), A.bp);

  function startDrill() {
    const drill = DRILLS.find(d => d.id === A.drillId);
    if (!drill || DRILL_COMPAT(drill.id).length) return;
    const seed = Math.floor(Math.random() * 1e9);
    A.sim = new S.Simulator(A.bp, { seed });
    A.session = new D.Session(A.sim, drill, { mode: A.mode, seed });
    A.feed = []; A.approval = null; A.debrief = null; A.running = true; A.acc = 0; A.ended = false;
    A.selected = (A.bp.components.find(c => c.type === 'service') || A.bp.components[0]).id;
    A.tab = 'run'; renderAll();
  }
  function endDrill(reason) {
    if (!A.session) return;
    if (A.session.state === 'running') A.session.finish(reason || 'abandoned');
    A.debriefReason = A.session.endReason;
    A.debrief = A.session.debrief();
    A.debrief.drill = A.session.drill; A.debrief.mode = A.session.mode;
    A.session = null; A.running = false; A.approval = null; A.ended = true;
    A.tab = 'debrief'; renderAll();
    if (A.debriefReason !== 'abandoned') toast(A.debriefReason === 'recovered' ? 'Business flow recovered. Drill complete.' : 'Cut-off reached. Drill over.');
  }
  function resetSandbox() {
    A.sim = new S.Simulator(A.bp, { seed: Math.floor(Math.random() * 1e9) });
    A.session = null; A.feed = []; A.approval = null; A.running = true; A.acc = 0; A.ended = false; renderAll();
  }

  // ------------------------------------------------------------ the clock
  setInterval(() => {
    if (!A.running || !A.sim) return;
    A.acc += 0.25 * SIM_SECONDS_PER_REAL_SECOND * A.speed;
    while (A.acc >= 5) {
      A.acc -= 5;
      if (A.session) {
        A.session.tick(5);
        if (A.session.state !== 'running') { endDrill(A.session.endReason); return; }
      } else A.sim.step(5);
    }
    updateLive();
  }, 250);

  // ------------------------------------------------------------ formatting
  const money = n => `${A.bp.business.currency}${S.fmtInt(n)} ${A.bp.business.unit}`;
  function fmtMetric(m, v) {
    if (m.endsWith('_rate') && (m === 'reject_rate' || m === 'error_rate')) return v.toFixed(1) + '%';
    if (m.endsWith('_rate')) return S.fmtInt(v) + '/min';
    if (m === 'pool_pct') return v.toFixed(0) + '%';
    if (m === 'staleness_min') return v.toFixed(0) + ' min';
    if (m === 'latency_ms' || m === 'wait_ms') return S.fmtInt(v) + ' ms';
    return S.fmtInt(v);
  }
  const shortName = (s, n) => s.length > n ? s.slice(0, n - 1) + '…' : s;
  function keyMetric(id) {
    const s = A.sim.c[id], m = k => A.sim.metric(id, k);
    switch (s.type) {
      case 'source': return `${S.fmtInt(m('out_rate'))}/min produced`;
      case 'kafka_topic': return `lag ${S.fmtInt(m('lag'))}`;
      case 'service': return `${S.fmtInt(m('out_rate'))}/min · ${m('instances')}/${s.configured} up${s.rejected >= 1 ? ' · ' + S.fmtInt(s.rejected) + ' rej' : ''}`;
      case 'external_party': return `${S.fmtInt(m('out_rate'))}/min · ${S.fmtInt(m('backlog'))} waiting`;
      case 'ref_data': return `loaded ${m('staleness_min').toFixed(0)} min ago`;
      case 'database': return `pool ${m('pool_used')}/${s.def.pool_size}`;
    }
    return '';
  }

  // ------------------------------------------------------------ system map
  function layout(bp) {
    const colW = 214, boxW = 156, boxH = 78, depGap = 104;
    const pos = {}; let y = 26, maxX = 0;
    bp.chains.forEach(chain => {
      chain.forEach((id, i) => { pos[id] = { x: 20 + i * colW, y }; maxX = Math.max(maxX, 20 + i * colW + boxW); });
      const hasDeps = chain.some(id => (bp.byId[id].uses || []).length);
      chain.forEach(id => {
        const uses = (bp.byId[id].uses || []).filter(u => !pos[u]);
        uses.forEach((u, j) => {
          const x = Math.max(20, pos[id].x + (j - (uses.length - 1) / 2) * (boxW + 18));
          pos[u] = { x, y: y + boxH + depGap - 40 }; maxX = Math.max(maxX, x + boxW);
        });
      });
      y += boxH + (hasDeps ? depGap + boxH - 40 : 0) + 46;
    });
    return { pos, boxW, boxH, W: maxX + 20, H: y - 20 };
  }
  function drawMap() {
    const L = A.layout, sim = A.sim, bp = A.bp, W = L.W, H = L.H, bw = L.boxW, bh = L.boxH;
    let g = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="System map of ${esc(bp.system)}"><defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M1 1 9 5 1 9" fill="none" stroke="currentColor" stroke-width="1.6" style="color:var(--muted)"/></marker></defs>`;
    bp.chains.forEach(chain => chain.slice(0, -1).forEach((id, i) => {
      const a = L.pos[id], b = L.pos[chain[i + 1]];
      const y = a.y + bh / 2, down = sim.c[chain[i + 1]];
      const rate = down.type === 'service' && sim.c[id].type === 'kafka_topic' ? sim.metric(down.def.id, 'in_rate') : sim.metric(chain[i + 1], 'in_rate');
      g += `<path class="edge" d="M${a.x + bw} ${y} L${b.x - 2} ${y}" marker-end="url(#arr)"/><text class="edge-l" x="${(a.x + bw + b.x) / 2}" y="${y - 7}" text-anchor="middle">${S.fmtInt(rate)}/min</text>`;
    }));
    bp.components.forEach(c => (c.uses || []).forEach(u => {
      const a = L.pos[c.id], b = L.pos[u]; if (!a || !b) return;
      const ax = a.x + bw / 2, bx = b.x + bw / 2, my = (a.y + bh + b.y) / 2;
      g += `<path class="edge dep" d="M${ax} ${a.y + bh} L${ax} ${my} L${bx} ${my} L${bx} ${b.y - 2}"/>`;
    }));
    bp.components.forEach(c => {
      const p = L.pos[c.id]; if (!p) return;
      const h = sim.health(c.id), s = sim.c[c.id];
      g += `<g class="node ${h}${A.selected === c.id ? ' sel' : ''}" data-node="${c.id}" tabindex="0" role="button" aria-label="${esc(c.name)}, ${h}">`
        + `<rect class="box" x="${p.x}" y="${p.y}" width="${bw}" height="${bh}" rx="7"/><rect class="bar" x="${p.x}" y="${p.y}" width="5" height="${bh}" rx="2"/>`
        + `<text x="${p.x + 14}" y="${p.y + 21}" font-size="13.5" font-weight="600">${esc(shortName(c.name, 19))}</text>`
        + `<text class="k" x="${p.x + 14}" y="${p.y + 37}">${esc(S.TYPES[c.type].label)}${c.type === 'kafka_topic' ? ' · ' + c.partitions + ' partitions' : ''}</text>`
        + `<text class="m" x="${p.x + 14}" y="${p.y + 56}">${esc(keyMetric(c.id))}</text>`;
      if (c.type === 'kafka_topic') {
        const max = Math.max(150, ...s.parts), n = s.parts.length, pw = (bw - 28) / n;
        s.parts.forEach((v, i) => {
          const hh = Math.max(1, (v / max) * 12);
          g += `<rect class="ptrack" x="${p.x + 14 + i * pw}" y="${p.y + 62}" width="${pw - 2}" height="12"/><rect class="pbar${v > max * 0.5 && v > 120 ? ' hot' : ''}" x="${p.x + 14 + i * pw}" y="${p.y + 74 - hh}" width="${pw - 2}" height="${hh}"/>`;
        });
      }
      g += `</g>`;
    });
    return g + '</svg>';
  }

  // ------------------------------------------------------------ inspector
  function spark(arr) {
    const pts = arr.slice(-60); if (pts.length < 2) return '<svg viewBox="0 0 100 34"></svg>';
    const max = Math.max(...pts), min = Math.min(...pts), rng = max - min || 1;
    const xy = pts.map((v, i) => [i / (pts.length - 1) * 100, 31 - ((v - min) / rng) * 27]);
    const line = xy.map(p => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ');
    const last = xy[xy.length - 1];
    return `<svg viewBox="0 0 100 34" preserveAspectRatio="none" aria-hidden="true"><polygon class="spark-a" points="0,34 ${line} 100,34"/><polyline class="spark-l" points="${line}" vector-effect="non-scaling-stroke"/><circle class="spark-d" cx="${last[0]}" cy="${last[1]}" r="2.2" vector-effect="non-scaling-stroke"/></svg>`;
  }
  function drawInspector() {
    const id = A.selected, s = A.sim.c[id]; if (!s) return;
    const h = A.sim.health(id);
    $('#insTitle').innerHTML = `${esc(s.def.name)} <span class="pill ${h === 'ok' ? 'ok' : h}">${h === 'ok' ? 'healthy' : h === 'warn' ? 'degraded' : 'critical'}</span>`;
    $('#insType').textContent = `${S.TYPES[s.type].label} · id ${id}${s.def.uses ? ' · uses ' + s.def.uses.join(', ') : ''}`;
    const M = S.TYPES[s.type].metrics;
    $('#tiles').innerHTML = Object.keys(M).map(m => `<div class="tile"><div class="label">${esc(M[m])}</div><div class="v">${fmtMetric(m, A.sim.metric(id, m))}</div>${spark(s.hist[m] || [])}</div>`).join('')
      + (s.type === 'kafka_topic' ? `<div class="tile"><div class="label">Lag by partition</div><div class="mono small">${s.parts.map((v, i) => `p${i}: ${S.fmtInt(v)}`).join('<br>')}</div></div>` : '');
    const term = $('#logs');
    const near = term.scrollHeight - term.scrollTop - term.clientHeight < 40;
    const logs = s.logs.filter(l => !A.errorsOnly || l.level !== 'INFO').slice(-150);
    term.innerHTML = logs.length ? logs.map(l => `<span class="${l.level[0]}">${esc(l.line)}</span>`).join('\n') : '<span>No log lines yet.</span>';
    if (near) term.scrollTop = term.scrollHeight;
  }

  // ------------------------------------------------------------ live updates (every tick)
  function updateLive() {
    const sim = A.sim; if (!sim) return;
    $('#clock').textContent = sim.time(true);
    const left = Math.round((A.bp.cutoff - sim.t) / 60);
    $('#cutoff').textContent = left > 0 ? `Cut-off ${S.clockStr(A.bp.cutoff)} · ${left} min left` : `Cut-off ${S.clockStr(A.bp.cutoff)} passed`;
    const risk = sim.cutoffRisk().atRisk;
    $('#kpis').innerHTML = sim.kpis().map(k => {
      const cls = k.trades > A.bp.business.tolerance_trades ? (k.cutoff && risk ? 'bad' : 'warn') : '';
      return `<div class="kpi"><span class="label">${esc(k.label)}${k.cutoff ? ' (cut-off)' : ''}</span><span class="v ${cls}">${money(k.notional)}</span><span class="small muted mono">${S.fmtInt(k.trades)} trades</span></div>`;
    }).join('');
    const chip = $('#stateChip');
    chip.className = 'state-chip' + (A.session ? ' live' : '');
    chip.textContent = A.session ? `Drill: ${A.session.drill.title}` : A.ended ? 'Drill ended' : 'Sandbox';
    $('#pauseBtn').disabled = !!A.ended;
    $('#pauseBtn').textContent = A.running ? 'Pause' : 'Resume';
    if (A.tab !== 'run') return;
    $('#map').innerHTML = drawMap();
    drawInspector();
    const firing = sim.alerts.filter(a => a.status === 'FIRING').length;
    $('#alertCount').textContent = firing ? `${firing} firing` : 'none firing';
    $('#alerts').innerHTML = sim.alerts.length ? sim.alerts.slice().sort((a, b) => (a.status === 'FIRING' ? 0 : 1) - (b.status === 'FIRING' ? 0 : 1) || b.firedAt - a.firedAt).map(a =>
      `<button class="alert${a.status === 'RESOLVED' ? ' resolved' : ''}" data-alert-on="${esc(a.on)}"><span class="pill ${a.severity === 'P1' ? 'bad' : a.severity === 'P2' ? 'warn' : 'mut'}">${a.severity}</span><span>${esc(a.name)}<br><span class="small muted">${esc(sim.c[a.on] ? sim.c[a.on].def.name : a.on)}${a.threshold ? ' · ' + esc(a.threshold) : ''}</span></span><span class="when">${S.clockStr(a.firedAt)}${a.status === 'RESOLVED' ? '<br>resolved' : ''}</span></button>`).join('')
      : '<p class="small muted" style="margin:0">No alerts. Alert rules come from the blueprint.</p>';
    if (A.session) {
      const ss = A.session;
      $('#ackStatus').textContent = ss.ackAt === null ? 'Not acknowledged' : `Acknowledged at ${S.clockStr(ss.ackAt)} by ${ss.ackBy}`;
      $('#ackBtn').disabled = ss.ackAt !== null;
      const hints = ss.visibleHints();
      $('#hints').innerHTML = hints.map(h => `<div class="hint">${esc(h)}</div>`).join('');
    }
  }

  // ------------------------------------------------------------ views
  function renderAll() {
    document.querySelectorAll('.tabs button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === A.tab)));
    const v = { drills: viewDrills, run: viewRun, blueprint: viewBlueprint, debrief: viewDebrief }[A.tab];
    $('#main').innerHTML = v();
    wire();
    updateLive();
  }

  function viewDrills() {
    const sel = DRILLS.find(d => d.id === A.drillId);
    return `<div class="stack">
      <section class="panel stack">
        <div><h2>Incident drills</h2><p class="muted" style="margin:4px 0 0;max-width:70ch">Pick a drill and start it. Faults are injected into the simulated <b>${esc(A.bp.system)}</b> without telling you what or where. Investigate, declare the root cause, request approved fixes, and get scored on speed, accuracy, safety and the business cut-off.</p></div>
        <div class="setup">
          <label class="field">Your name (shown on acknowledgements)<input type="text" id="responder" value="${esc(A.responder)}" placeholder="e.g. Priya, L2 Support" autocomplete="off"></label>
          <label class="field">Mode<select id="mode"><option value="practice"${A.mode === 'practice' ? ' selected' : ''}>Practice: hints and feedback</option><option value="assessment"${A.mode === 'assessment' ? ' selected' : ''}>Assessment: no hints</option></select></label>
          <label class="field">Speed<select id="speedSel">${[1, 2, 4, 8].map(x => `<option value="${x}"${A.speed === x ? ' selected' : ''}>${x}× (1 s = ${x * 10} s)</option>`).join('')}</select></label>
          <button class="btn primary" id="startBtn" ${DRILL_COMPAT(A.drillId).length ? 'disabled' : ''}>Start “${esc(sel.title)}”</button>
        </div>
      </section>
      <div class="lib">${DRILLS.map(d => {
        const errs = DRILL_COMPAT(d.id);
        return `<button class="card" data-drill="${d.id}" aria-pressed="${d.id === A.drillId}" ${errs.length ? 'disabled' : ''}>
          <div class="row between"><span class="pill ${d.level === 'Easy' ? 'ok' : d.level === 'Medium' ? 'warn' : 'bad'}">${esc(d.level)}</span>${d.mystery ? '<span class="pill mut">random fault</span>' : ''}</div>
          <h3>${esc(d.title)}</h3><span class="small muted">${esc(d.summary || '')}</span>
          ${errs.length ? `<span class="small" style="color:var(--bad)">Not available on this blueprint: ${esc(errs[0])}</span>` : ''}</button>`;
      }).join('')}</div>
      <details class="panel"><summary class="label" style="cursor:pointer">Drill file: ${esc(sel.id)}.yaml</summary><p class="small muted">Drills are plain YAML files: faults, the correct root cause, accepted and risky actions, hints and the debrief. Adding a drill needs no code.</p><pre class="term" style="height:auto;max-height:420px">${esc(DRILL_TEXT[sel.id])}</pre></details>
    </div>`;
  }

  function compOptions(filter) {
    return A.bp.components.filter(filter).map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  }
  function viewRun() {
    const ss = A.session;
    const side = ss ? `
      <section class="panel stack"><div class="row between"><h2>Briefing</h2><span class="pill ${ss.mode === 'practice' ? 'info' : 'mut'}">${ss.mode}</span></div>
        <p class="brief" style="margin:0">${esc(ss.drill.brief)}</p><div id="hints" class="stack" style="gap:6px"></div></section>
      <section class="panel stack"><h2>Respond</h2>
        <div class="row between"><span id="ackStatus" class="small muted"></span><button class="btn" id="ackBtn">Acknowledge</button></div>
        <div class="stack" style="gap:6px"><span class="label">Declare root cause</span>
          <div class="row"><select id="rcComp" aria-label="Component">${compOptions(c => Object.keys(S.TYPES[c.type].faults).length)}</select><select id="rcFault" aria-label="Fault"></select><button class="btn" id="rcBtn">Declare</button></div></div>
        ${actionPicker()}
        <div class="feed" id="feed">${feedHtml()}</div>
        <button class="btn" id="endBtn">End drill and see debrief</button>
      </section>` : `
      <section class="panel stack"><h2>Sandbox</h2>
        <p class="small muted" style="margin:0">${A.ended ? 'The drill has ended and the system is frozen at that moment. Inspect it, or reset to start a fresh sandbox.' : `Free play on <b>${esc(A.bp.system)}</b>. Break any component and watch the effect spread through the flow, or start a scored drill from the Drills tab.`}</p>
        <div class="stack" style="gap:6px"><span class="label">Break something</span>
          <div class="row"><select id="fxComp" aria-label="Component">${compOptions(c => Object.keys(S.TYPES[c.type].faults).length)}</select><select id="fxFault" aria-label="Fault"></select><button class="btn danger" id="fxBtn">Inject fault</button></div></div>
        ${actionPicker()}
        <div class="feed" id="feed">${feedHtml()}</div>
        <button class="btn" id="resetBtn">Reset sandbox to healthy</button>
      </section>`;
    return `<div class="run">
      <div class="stack">
        <section class="panel stack"><div class="row between"><h2>${esc(A.bp.system)}</h2><span class="small muted">Click a component to inspect it. Dashed lines show what a service depends on.</span></div><div class="map" id="map"></div></section>
        <section class="panel stack"><div class="row between"><div><h2 id="insTitle"></h2><span class="small muted" id="insType"></span></div></div>
          <div class="tiles" id="tiles"></div>
          <div class="row between"><span class="label">Logs</span><label class="small row" style="gap:6px"><input type="checkbox" id="errOnly" ${A.errorsOnly ? 'checked' : ''}> Warnings and errors only</label></div>
          <div class="term" id="logs" tabindex="0" aria-label="Component logs"></div></section>
      </div>
      <div class="stack">${side}
        <section class="panel stack"><div class="row between"><h2>Alerts</h2><span class="small muted" id="alertCount"></span></div><div class="alerts" id="alerts"></div></section>
      </div></div>`;
  }
  function actionPicker() {
    return `<div class="stack" style="gap:6px"><span class="label">Request an action</span>
      <div class="row"><select id="acComp" aria-label="Component">${compOptions(c => Object.keys(S.TYPES[c.type].actions).length)}</select><select id="acAction" aria-label="Action"></select><button class="btn" id="acBtn">Request approval</button></div>
      <div id="approval">${approvalHtml()}</div></div>`;
  }
  function approvalHtml() {
    const ap = A.approval; if (!ap) return '';
    const c = A.bp.byId[ap.comp], act = S.TYPES[c.type].actions[ap.action];
    return `<div class="approve" role="group" aria-label="Approval">
      <b>${esc(act.label)}</b><span class="small">on ${esc(c.name)}. This changes the system. It runs only with a named approver and confirmation, and is recorded.</span>
      <label class="field">Approver<input type="text" id="apprName" placeholder="e.g. Rahul Mehta, Support Manager" autocomplete="off" value="${esc(ap.name || '')}"></label>
      <label class="small row" style="gap:6px"><input type="checkbox" id="apprChk"> I confirm this action</label>
      ${ap.error ? `<span class="err">${esc(ap.error)}</span>` : ''}
      <div class="row"><button class="btn" id="apprCancel">Cancel</button><button class="btn danger" id="apprGo">Approve and run</button></div></div>`;
  }
  function feedHtml() {
    return A.feed.slice(-12).reverse().map(f => `<div class="${f.cls || ''}"><span class="mono muted">${f.t}</span> ${esc(f.text)}</div>`).join('');
  }
  function pushFeed(text, cls) { A.feed.push({ t: A.sim.time(), text, cls }); const el = $('#feed'); if (el) el.innerHTML = feedHtml(); }

  function viewBlueprint() {
    const types = Object.entries(S.TYPES).map(([k, T]) => `<tr><td><code>${k}</code></td><td class="small">${T.required.map(r => `<code>${r}</code>`).join(' ')}${k === 'service' ? ' <span class="muted">(optional: <code>instances</code>, <code>uses</code>)</span>' : ''}${k === 'kafka_topic' ? ' <span class="muted">(optional: <code>consumer_group</code>)</span>' : ''}</td><td class="small">${Object.keys(T.metrics).map(m => `<code>${m}</code>`).join(' ')}</td><td class="small">${Object.values(T.faults).map(f => esc(f.label)).join('; ') || '—'}</td></tr>`).join('');
    return `<div class="bp">
      <section class="panel stack">
        <div class="row between"><h2>Blueprint</h2><label class="row small" style="gap:6px">Start from<select id="preset">${Object.keys(C.blueprints).map(n => `<option value="${n}"${n === A.bpName ? ' selected' : ''}>${n}</option>`).join('')}</select></label></div>
        <p class="small muted" style="margin:0">Describe the system as components, a flow and alert rules. Edit the YAML, then load it. ${A.session ? '<b>Loading ends the current drill.</b>' : ''}</p>
        <textarea class="code" id="bpText" spellcheck="false" aria-label="Blueprint YAML">${esc(A.bpEditing != null ? A.bpEditing : A.bpText)}</textarea>
        <div class="row"><button class="btn" id="bpCheck">Check</button><button class="btn primary" id="bpLoad">Load into simulator</button></div>
        <div id="bpMsg">${A.bpMsg || ''}</div>
      </section>
      <section class="panel stack">
        <h2>How a blueprint works</h2>
        <p class="small" style="margin:0">Component <b>types</b> are built into the engine: they know how to behave, what to measure, how they fail and how they are fixed. A blueprint only says which components exist and how they connect, so a new system needs no code.</p>
        <h3>Example: put Kafka between two systems</h3>
        <pre class="term" style="height:auto">components:
  - {id: oms, type: source, name: Order Management, rate_per_min: 300}
  <span class="W">- {id: trades_topic, type: kafka_topic, name: trades.executed,
     partitions: 6, consumer_group: tam-allocator}</span>
  - {id: tam, type: service, name: Allocation Engine, capacity_per_min: 420}
flow:
  - oms <span class="W">-> trades_topic</span> -> tam</pre>
        <p class="small muted" style="margin:0">With Kafka in between, a slow allocator no longer slows the OMS. The early signal becomes consumer lag, and a single stuck partition becomes possible. Compare the two presets.</p>
        <h3>Component types</h3>
        <div class="tablewrap"><table><thead><tr><th>Type</th><th>Settings</th><th>Metrics for alerts</th><th>Faults</th></tr></thead><tbody>${types}</tbody></table></div>
        <p class="small muted" style="margin:0">Rules: a flow starts with a <code>source</code>; reference data and databases attach to a service with <code>uses</code>; alert rules use <code>above</code> or <code>below</code>; one business KPI can be marked <code>cutoff: true</code>.</p>
      </section></div>`;
  }

  function viewDebrief() {
    const d = A.debrief;
    if (!d) return `<div class="panel empty">Finish a drill to see its debrief here.</div>`;
    const sc = d.score, t = sc.times, n = d.notes || {};
    const tm = (v, suf) => v === null || v === undefined ? '—' : v + (suf || ' min');
    const reason = { recovered: 'Business flow recovered', cutoff: 'Cut-off reached', abandoned: 'Ended by responder' }[A.debriefReason || 'abandoned'];
    return `<div class="stack">
      <section class="panel score"><div><div class="big">${sc.total}</div><div class="label">of 100 · ${esc(sc.grade)}</div></div>
        <div class="stack" style="gap:6px"><h2>${esc(d.drill.title)}</h2><span class="small muted">${esc(d.mode)} mode · ${esc(reason)}</span>
          <div class="parts">${sc.parts.map(p => `<div class="part"><span>${esc(p.label)}</span><div class="track"><div class="fill" style="width:${p.pts / p.max * 100}%"></div></div><span class="mono">${p.pts}/${p.max}</span><span class="note">${esc(p.note)}</span></div>`).join('')}</div></div></section>
      <div class="times">
        <div class="panel"><div class="label">Fault started</div><div class="mono" style="font-size:18px">${S.clockStr(t.fault)}</div></div>
        <div class="panel"><div class="label">Time to detect</div><div class="mono" style="font-size:18px">${tm(t.detect)}</div></div>
        <div class="panel"><div class="label">Time to acknowledge</div><div class="mono" style="font-size:18px">${tm(t.mtta)}</div></div>
        <div class="panel"><div class="label">Time to diagnose</div><div class="mono" style="font-size:18px">${tm(t.diagnose)}</div></div>
        <div class="panel"><div class="label">Time to recover</div><div class="mono" style="font-size:18px">${tm(t.recover)}</div></div>
      </div>
      <div class="bp">
        <section class="panel stack"><h2>What happened</h2>
          <p style="margin:0"><b>Root cause:</b> ${esc(d.answer.fault)} on ${esc(d.answer.component)}.</p>
          ${n.what_happened ? `<p style="margin:0">${esc(n.what_happened)}</p>` : ''}
          ${n.key_signal ? `<p style="margin:0"><b>The signal to spot:</b> ${esc(n.key_signal)}</p>` : ''}
          ${n.why_not_restart ? `<p style="margin:0"><b>Why not just restart:</b> ${esc(n.why_not_restart)}</p>` : ''}
          <p style="margin:0"><b>Accepted fix:</b> ${esc(d.accepted.join(', then '))}.</p>
          ${n.runbook ? `<h3>Runbook</h3><ol style="margin:0;padding-left:20px">${n.runbook.map(r => `<li>${esc(r)}</li>`).join('')}</ol>` : ''}
          <h3>Your decisions</h3>
          ${d.declarations.length ? `<ul style="margin:0;padding-left:20px">${d.declarations.map(x => `<li><span class="mono">${S.clockStr(x.t)}</span> Declared ${esc(x.label)} <span class="cls ${x.correct ? 'accepted' : 'risky'}">${x.correct ? 'correct' : 'incorrect'}</span></li>`).join('')}</ul>` : '<p class="small muted" style="margin:0">No root cause declared.</p>'}
          ${d.actions.length ? `<ul style="margin:0;padding-left:20px">${d.actions.map(x => `<li><span class="mono">${S.clockStr(x.t)}</span> ${esc(x.label)} on ${esc(A.bp.byId[x.component] ? A.bp.byId[x.component].name : x.component)}, approved by ${esc(x.approver)} <span class="cls ${x.cls}">${x.cls}</span></li>`).join('')}</ul>` : '<p class="small muted" style="margin:0">No actions taken.</p>'}
          <p class="small muted" style="margin:0">Inspected: ${d.inspected.length ? esc(d.inspected.join(', ')) : 'nothing'}.</p>
        </section>
        <section class="panel stack"><h2>Timeline</h2><ul class="tl">${d.timeline.map(e => `<li class="k-${e.kind}"><time>${S.clockStr(e.t)}</time><span>${esc(e.text)}</span></li>`).join('')}</ul></section>
      </div>
      <div class="row"><button class="btn primary" id="againBtn">Run this drill again</button><button class="btn" id="otherBtn">Choose another drill</button></div>
    </div>`;
  }

  // ------------------------------------------------------------ events
  function fillFaults(compSel, faultSel) {
    const c = A.bp.byId[$(compSel).value]; if (!c) return;
    $(faultSel).innerHTML = Object.entries(S.TYPES[c.type].faults).map(([k, f]) => `<option value="${k}">${esc(f.label)}</option>`).join('');
  }
  function fillActions() {
    const c = A.bp.byId[$('#acComp').value]; if (!c) return;
    $('#acAction').innerHTML = Object.entries(S.TYPES[c.type].actions).map(([k, a]) => `<option value="${k}">${esc(a.label)}</option>`).join('');
  }
  function wire() {
    const on = (sel, ev, fn) => { const el = $(sel); if (el) el.addEventListener(ev, fn); };
    // drills
    document.querySelectorAll('[data-drill]').forEach(b => b.addEventListener('click', () => { A.drillId = b.dataset.drill; renderAll(); }));
    on('#responder', 'input', e => { A.responder = e.target.value; store.set('responder', A.responder); });
    on('#mode', 'change', e => { A.mode = e.target.value; store.set('mode', A.mode); });
    on('#speedSel', 'change', e => { A.speed = +e.target.value; $('#speed').value = String(A.speed); });
    on('#startBtn', 'click', startDrill);
    // run
    on('#map', 'click', e => { const n = e.target.closest('[data-node]'); if (n) select(n.dataset.node); });
    on('#map', 'keydown', e => { const n = e.target.closest('[data-node]'); if (n && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); select(n.dataset.node); } });
    on('#alerts', 'click', e => { const b = e.target.closest('[data-alert-on]'); if (b && A.sim.c[b.dataset.alertOn]) select(b.dataset.alertOn); });
    on('#errOnly', 'change', e => { A.errorsOnly = e.target.checked; drawInspector(); });
    if ($('#rcComp')) { fillFaults('#rcComp', '#rcFault'); on('#rcComp', 'change', () => fillFaults('#rcComp', '#rcFault')); }
    if ($('#fxComp')) { fillFaults('#fxComp', '#fxFault'); on('#fxComp', 'change', () => fillFaults('#fxComp', '#fxFault')); }
    if ($('#acComp')) { fillActions(); on('#acComp', 'change', fillActions); }
    on('#ackBtn', 'click', () => { if (A.session.acknowledge(A.responder.trim() || 'Responder')) { pushFeed('Incident acknowledged'); updateLive(); } });
    on('#rcBtn', 'click', () => {
      const comp = $('#rcComp').value, fault = $('#rcFault').value, ss = A.session;
      const ok = ss.declare(comp, fault);
      const label = `${S.TYPES[A.bp.byId[comp].type].faults[fault].label} on ${A.bp.byId[comp].name}`;
      if (ss.mode === 'practice') pushFeed(ok ? `Root cause confirmed: ${label}. Now fix it.` : `Declared ${label}. The evidence does not support this; keep looking.`, ok ? 'ok' : 'bad');
      else pushFeed(`Root cause recorded: ${label}`);
    });
    on('#fxBtn', 'click', () => {
      const comp = $('#fxComp').value, fault = $('#fxFault').value;
      A.sim.injectFault(comp, fault); pushFeed(`Injected: ${S.TYPES[A.bp.byId[comp].type].faults[fault].label} on ${A.bp.byId[comp].name}`, 'bad'); updateLive();
    });
    on('#acBtn', 'click', () => { A.approval = { comp: $('#acComp').value, action: $('#acAction').value, name: '' }; $('#approval').innerHTML = approvalHtml(); wireApproval(); $('#apprName').focus(); });
    wireApproval();
    on('#endBtn', 'click', () => endDrill('abandoned'));
    on('#resetBtn', 'click', resetSandbox);
    // blueprint
    on('#preset', 'change', e => { A.bpName = e.target.value; A.bpEditing = C.blueprints[A.bpName]; A.bpMsg = null; renderAll(); });
    on('#bpText', 'input', e => { A.bpEditing = e.target.value; });
    on('#bpCheck', 'click', () => {
      const r = S.parseBlueprint($('#bpText').value, yaml);
      A.bpMsg = r.errors.length ? `<ul class="errors">${r.errors.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : `<span class="okmsg">Valid: ${r.blueprint.components.length} components, ${r.blueprint.alerts.length} alert rules. Drills available: ${DRILLS.filter(d => !D.validateDrill(d, r.blueprint).length).length} of ${DRILLS.length}.</span>`;
      $('#bpMsg').innerHTML = A.bpMsg;
    });
    on('#bpLoad', 'click', () => {
      const text = $('#bpText').value, errs = loadBlueprint(text);
      if (errs.length) { A.bpMsg = `<ul class="errors">${errs.map(x => `<li>${esc(x)}</li>`).join('')}</ul>`; $('#bpMsg').innerHTML = A.bpMsg; return; }
      A.bpEditing = null; A.bpMsg = null; A.running = true; A.tab = 'run'; renderAll(); toast(`Loaded “${A.bp.system}”. Sandbox running.`);
    });
    // debrief
    on('#againBtn', 'click', startDrill);
    on('#otherBtn', 'click', () => { A.tab = 'drills'; renderAll(); });
  }
  function wireApproval() {
    const go = $('#apprGo'); if (!go) return;
    $('#apprCancel').addEventListener('click', () => { A.approval = null; $('#approval').innerHTML = ''; });
    $('#apprName').addEventListener('input', e => { A.approval.name = e.target.value; });
    go.addEventListener('click', () => {
      const ap = A.approval, name = $('#apprName').value.trim(), ok = $('#apprChk').checked;
      let r;
      if (!name) r = { ok: false, message: 'Enter the approver’s name.' };
      else if (!ok) r = { ok: false, message: 'Tick the confirmation box to approve.' };
      else if (A.session) r = A.session.requestAction(ap.comp, ap.action, name, ok);
      else r = A.sim.applyAction(ap.comp, ap.action);
      if (!r.ok) { ap.error = r.message; ap.name = name; $('#approval').innerHTML = approvalHtml(); wireApproval(); return; }
      A.approval = null; $('#approval').innerHTML = '';
      pushFeed(`${r.label} (approved by ${name}): ${r.message}`, r.effect === 'fixed' ? 'ok' : '');
      updateLive();
    });
  }
  function select(id) { A.selected = id; if (A.session) A.session.inspect(id); updateLive(); }

  let toastT;
  function toast(t) { const el = $('#toast'); el.textContent = t; el.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { el.hidden = true; }, 3200); }

  // top-level controls
  document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => { A.tab = b.dataset.tab; renderAll(); }));
  $('#pauseBtn').addEventListener('click', () => { A.running = !A.running; updateLive(); });
  $('#speed').addEventListener('change', e => { A.speed = +e.target.value; const s = $('#speedSel'); if (s) s.value = String(A.speed); });

  loadBlueprint(C.blueprints[A.bpName]);
  renderAll();
  window.__drillApp = A; // exposed for automated tests
})();
