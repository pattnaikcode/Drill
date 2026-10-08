/* OpsPilot Drill Simulator — user interface.
 * engine.js (simulation), session.js (drill rules) and tools.js (Splunk, SQL, Unix) hold all logic.
 * This file draws state and turns clicks into calls on them. Controls people type into are built
 * once per view; only live parts (clock, map, alerts, charts, inspector) refresh on each tick.
 */
(function () {
  'use strict';
  const S = window.OpsSim, D = window.OpsDrill, TL = window.OpsTools, yaml = window.jsyaml, C = window.DRILL_CONTENT;
  const $ = s => document.querySelector(s);
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k, d) { try { const v = localStorage.getItem('opsdrill.' + k); return v === null ? d : v; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('opsdrill.' + k, v); } catch (e) { /* storage unavailable */ } },
  };
  const SIM_SECONDS_PER_REAL_SECOND = 10; // at 1× speed

  // ------------------------------------------------------------ systems and use cases
  const SYSTEMS = {}; // id -> { text, bp, builtIn }
  Object.values(C.blueprints).forEach(text => { const r = S.parseBlueprint(text, yaml); if (!r.errors.length) SYSTEMS[r.blueprint.id] = { text, bp: r.blueprint, builtIn: true }; });
  try { JSON.parse(store.get('systems', '[]')).forEach(text => { const r = S.parseBlueprint(text, yaml); if (!r.errors.length) SYSTEMS[r.blueprint.id] = { text, bp: r.blueprint, builtIn: false }; }); } catch (e) { /* ignore */ }
  const BUILTIN_DRILLS = C.drills.map(t => ({ text: t, d: yaml.load(t), builtIn: true }));
  let CUSTOM_DRILLS = [];
  try { CUSTOM_DRILLS = JSON.parse(store.get('usecases', '[]')).map(t => ({ text: t, d: yaml.load(t), builtIn: false })); } catch (e) { CUSTOM_DRILLS = []; }
  const allDrills = () => [...BUILTIN_DRILLS, ...CUSTOM_DRILLS];
  const drillsFor = bp => allDrills().filter(x => D.drillFor(x.d, bp));
  const findDrill = id => allDrills().find(x => x.d.id === id);
  const saveCustom = () => {
    store.set('usecases', JSON.stringify(CUSTOM_DRILLS.map(x => x.text)));
    store.set('systems', JSON.stringify(Object.values(SYSTEMS).filter(s => !s.builtIn).map(s => s.text)));
  };

  const A = {
    tab: 'drills', sysId: SYSTEMS[C.default_blueprint] ? C.default_blueprint : Object.keys(SYSTEMS)[0],
    bp: null, sim: null, session: null, drillId: null, layout: null,
    mode: store.get('mode', 'practice'), responder: store.get('responder', ''),
    running: true, speed: 2, acc: 0, ended: false, selected: null, approval: null, feed: [], debrief: null, debriefReason: null,
    mapView: 'live', toolTab: 'component', errorsOnly: false,
    grafana: 'overview', splunkQ: 'level=ERROR OR level=WARN earliest=-15m', splunkR: null, sqlDb: null, sqlQ: 'SHOW TABLES', sqlR: null,
    unixHost: null, unixOut: [], designSys: null, designUC: null, designMsg: '', ucMsg: '',
  };

  // ------------------------------------------------------------ lifecycle
  function useSystem(id) {
    const sys = SYSTEMS[id]; if (!sys) return;
    A.sysId = id; A.bp = sys.bp; A.session = null; A.feed = []; A.approval = null; A.ended = false;
    A.sim = new S.Simulator(A.bp, { seed: 7 });
    A.layout = layout(A.bp);
    A.selected = (A.bp.components.find(c => c.type === 'service') || A.bp.components[0]).id;
    const list = drillsFor(A.bp);
    if (!list.some(x => x.d.id === A.drillId)) A.drillId = list.length ? list[0].d.id : null;
    const dbs = A.bp.components.filter(c => c.type === 'database');
    A.sqlDb = dbs.length ? dbs[0].id : null; A.sqlR = null;
    const hs = TL.hosts(A.sim); A.unixHost = hs.length ? hs[0].host : null; A.unixOut = [];
    A.splunkR = null; A.grafana = 'overview';
  }
  function startDrill() {
    const x = findDrill(A.drillId);
    if (!x || D.validateDrill(x.d, A.bp).length) return;
    const seed = Math.floor(Math.random() * 1e9);
    A.sim = new S.Simulator(A.bp, { seed });
    A.session = new D.Session(A.sim, x.d, { mode: A.mode, seed });
    A.feed = []; A.approval = null; A.debrief = null; A.running = true; A.acc = 0; A.ended = false;
    A.splunkR = null; A.sqlR = null; A.unixOut = [];
    A.selected = (A.bp.components.find(c => c.type === 'service') || A.bp.components[0]).id;
    A.tab = 'run'; renderAll();
  }
  function endDrill(reason) {
    if (!A.session) return;
    if (A.session.state === 'running') A.session.finish(reason || 'abandoned');
    A.debriefReason = A.session.endReason;
    A.debrief = A.session.debrief(); A.debrief.drill = A.session.drill; A.debrief.mode = A.session.mode;
    A.session = null; A.running = false; A.approval = null; A.ended = true;
    A.tab = 'debrief'; renderAll();
    if (A.debriefReason !== 'abandoned') toast(A.debriefReason === 'recovered' ? 'Business flow recovered. Drill complete.' : `${A.bp.clockLabel} reached. Drill over.`);
  }
  function resetSandbox() {
    A.sim = new S.Simulator(A.bp, { seed: Math.floor(Math.random() * 1e9) });
    A.session = null; A.feed = []; A.approval = null; A.running = true; A.acc = 0; A.ended = false; renderAll();
  }

  setInterval(() => {
    if (!A.running || !A.sim) return;
    A.acc += 0.25 * SIM_SECONDS_PER_REAL_SECOND * A.speed;
    while (A.acc >= 5) {
      A.acc -= 5;
      if (A.session) { A.session.tick(5); if (A.session.state !== 'running') { endDrill(A.session.endReason); return; } }
      else A.sim.step(5);
    }
    updateLive();
  }, 250);

  // ------------------------------------------------------------ formatting
  const money = n => `${A.bp.business.currency}${S.fmtInt(n)} ${A.bp.business.unit}`;
  function fmtMetric(m, v) {
    if (m === 'reject_rate' || m === 'error_rate') return v.toFixed(1) + '%';
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
      case 'source': return s.fault && s.fault.type === 'session_down' ? `disconnected · ${S.fmtInt(s.held)} queued` : `${S.fmtInt(m('out_rate'))}/min sent`;
      case 'kafka_topic': return `lag ${S.fmtInt(m('lag'))}`;
      case 'service': return `${S.fmtInt(m('out_rate'))}/min · ${m('instances')}/${s.configured} up${m('backlog') >= 50 ? ' · q ' + S.fmtInt(m('backlog')) : ''}`;
      case 'external_party': return `${S.fmtInt(m('out_rate'))}/min · ${S.fmtInt(m('backlog'))} waiting`;
      case 'ref_data': return `loaded ${m('staleness_min').toFixed(0)} min ago`;
      case 'database': return `pool ${m('pool_used')}/${s.def.pool_size}`;
      case 'issuer': return s.def.symbol ? `listed as ${s.def.symbol}` : 'listed company';
    }
    return '';
  }

  // ------------------------------------------------------------ layout shared by live map and flow diagram
  function layout(bp) {
    const colW = 200, rowH = 112, boxW = 164, boxH = 80, padX = 24, padTop = 44;
    const place = bp.diagram.place || {}, cr = {};
    const layer = {}, rowsUsed = {};
    bp.order.forEach(id => { layer[id] = Math.max(-1, ...bp.ups[id].map(u => layer[u])) + 1; });
    let maxFlowRow = 0;
    bp.order.forEach(id => {
      if (place[id]) { cr[id] = place[id]; } else { const col = layer[id]; const row = rowsUsed[col] || 0; rowsUsed[col] = row + 1; cr[id] = [col, row]; }
      maxFlowRow = Math.max(maxFlowRow, cr[id][1]);
    });
    bp.components.filter(c => c.type === 'service').forEach(svc => {
      const deps = (svc.uses || []).filter(u => !cr[u]);
      deps.forEach((u, j) => { cr[u] = place[u] || [cr[svc.id][0] + (j - (deps.length - 1) / 2) * 0.9, maxFlowRow + 1.3]; });
    });
    bp.components.filter(c => c.type === 'ref_data' || c.type === 'database').forEach(c => { if (!cr[c.id]) cr[c.id] = place[c.id] || [0, maxFlowRow + 1.3]; });
    const byRef = {};
    bp.components.filter(c => c.type === 'issuer').forEach(c => { (byRef[c.feeds] = byRef[c.feeds] || []).push(c.id); });
    Object.entries(byRef).forEach(([ref, ids]) => ids.forEach((id, j) => { if (!cr[id]) cr[id] = place[id] || [cr[ref][0] + (j - (ids.length - 1) / 2) * 0.9, cr[ref][1] + 1.4]; }));
    const pos = {}; let W = 0, H = 0;
    Object.entries(cr).forEach(([id, [c, r]]) => {
      pos[id] = { x: padX + Math.max(0, c) * colW, y: padTop + r * rowH };
      W = Math.max(W, pos[id].x + boxW + padX); H = Math.max(H, pos[id].y + boxH + 24);
    });
    const groups = (bp.diagram.groups || []).map(g => {
      const ps = g.ids.map(i => pos[i]).filter(Boolean); if (!ps.length) return null;
      const x0 = Math.min(...ps.map(p => p.x)) - 12, y0 = Math.min(...ps.map(p => p.y)) - 26;
      const x1 = Math.max(...ps.map(p => p.x)) + boxW + 12, y1 = Math.max(...ps.map(p => p.y)) + boxH + 12;
      return { label: g.label, x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    }).filter(Boolean);
    groups.forEach(g => { W = Math.max(W, g.x + g.w + 8); H = Math.max(H, g.y + g.h + 8); });
    return { pos, boxW, boxH, W, H, groups };
  }
  function cubic(a, b, L, vertical) { // connector between two boxes; returns path and a point function
    const bw = L.boxW, bh = L.boxH;
    let p0, p3, c1, c2;
    if (!vertical && b.x > a.x + bw * 0.6) { p0 = [a.x + bw, a.y + bh / 2]; p3 = [b.x - 3, b.y + bh / 2]; const dx = Math.max(30, (p3[0] - p0[0]) / 2); c1 = [p0[0] + dx, p0[1]]; c2 = [p3[0] - dx, p3[1]]; }
    else if (b.y > a.y) { p0 = [a.x + bw / 2, a.y + bh]; p3 = [b.x + bw / 2, b.y - 3]; const dy = Math.max(20, (p3[1] - p0[1]) / 2); c1 = [p0[0], p0[1] + dy]; c2 = [p3[0], p3[1] - dy]; }
    else { p0 = [a.x + bw / 2, a.y]; p3 = [b.x + bw / 2, b.y + bh + 3]; const dy = Math.max(20, (p0[1] - p3[1]) / 2); c1 = [p0[0], p0[1] - dy]; c2 = [p3[0], p3[1] + dy]; }
    const at = t => [0, 1].map(k => (1 - t) ** 3 * p0[k] + 3 * (1 - t) ** 2 * t * c1[k] + 3 * (1 - t) * t * t * c2[k] + t ** 3 * p3[k]);
    return { d: `M${p0[0]} ${p0[1]} C${c1[0]} ${c1[1]} ${c2[0]} ${c2[1]} ${p3[0]} ${p3[1]}`, at };
  }
  const roleOf = c => c.role || S.TYPES[c.type].label;

  function drawSystem(bp, sim, mode) { // mode: 'live' (metrics, health) or 'diagram' (roles, numbered steps)
    const L = mode === 'live' ? A.layout : layout(bp);
    const bw = L.boxW, bh = L.boxH, live = mode === 'live';
    let g = `<svg viewBox="0 0 ${L.W} ${L.H}" style="min-width:${Math.round(L.W * 0.62)}px" role="img" aria-label="${live ? 'Live map' : 'Flow diagram'} of ${esc(bp.system)}"><defs><marker id="arr-${mode}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M1 1 9 5 1 9" class="arrowhead"/></marker></defs>`;
    L.groups.forEach(gr => { g += `<rect class="grp" x="${gr.x}" y="${gr.y}" width="${gr.w}" height="${gr.h}" rx="10"/><text class="grp-l" x="${gr.x + 10}" y="${gr.y + 16}">${esc(gr.label)}</text>`; });
    const stepAt = {};
    if (!live) bp.diagram.steps.forEach((s, i) => { stepAt[s.from + '>' + s.to] = i + 1; });
    const badges = [];
    bp.edges.forEach(([a, b]) => {
      const cv = cubic(L.pos[a], L.pos[b], L);
      g += `<path class="edge" d="${cv.d}" marker-end="url(#arr-${mode})"/>`;
      if (stepAt[a + '>' + b]) badges.push([cv.at(0.5), stepAt[a + '>' + b]]);
    });
    bp.components.forEach(c => {
      const links = [...(c.uses || []).map(u => [c.id, u, 'dep']), ...(c.type === 'issuer' ? [[c.id, c.feeds, 'feed']] : [])];
      links.forEach(([a, b, k]) => {
        if (!L.pos[a] || !L.pos[b]) return;
        const cv = cubic(L.pos[a], L.pos[b], L, true);
        g += `<path class="edge ${k}" d="${cv.d}"/>`;
        if (stepAt[a + '>' + b]) badges.push([cv.at(0.5), stepAt[a + '>' + b]]);
      });
    });
    bp.components.forEach(c => {
      const p = L.pos[c.id]; if (!p) return;
      const h = live ? sim.health(c.id) : 'plain';
      const sel = live && A.selected === c.id ? ' sel' : '';
      g += `<g class="node ${h}${sel} t-${c.type}" data-node="${c.id}" ${live ? 'tabindex="0" role="button"' : ''} aria-label="${esc(c.name)}${live ? ', ' + h : ''}">`
        + `<rect class="box" x="${p.x}" y="${p.y}" width="${bw}" height="${bh}" rx="7"/><rect class="bar" x="${p.x}" y="${p.y}" width="5" height="${bh}" rx="2"/>`
        + `<text x="${p.x + 14}" y="${p.y + 22}" font-size="13.5" font-weight="600">${esc(shortName(c.name, 21))}</text>`
        + `<text class="k" x="${p.x + 14}" y="${p.y + 39}">${esc(roleOf(c))}${c.type === 'kafka_topic' ? ' · ' + c.partitions + ' partitions' : ''}</text>`;
      if (live) {
        g += `<text class="m" x="${p.x + 14}" y="${p.y + 58}">${esc(keyMetric(c.id))}</text>`;
        if (c.type === 'kafka_topic') {
          const s = sim.c[c.id], max = Math.max(150, ...s.parts), n = s.parts.length, pw = (bw - 28) / n;
          s.parts.forEach((v, i) => {
            const hh = Math.max(1, (v / max) * 11);
            g += `<rect class="ptrack" x="${p.x + 14 + i * pw}" y="${p.y + 64}" width="${pw - 2}" height="11"/><rect class="pbar${v > max * 0.5 && v > 120 ? ' hot' : ''}" x="${p.x + 14 + i * pw}" y="${p.y + 75 - hh}" width="${pw - 2}" height="${hh}"/>`;
          });
        }
      } else {
        const extra = [roleOf(c) !== S.TYPES[c.type].label ? S.TYPES[c.type].label : '', c.session ? 'session ' + c.session : '', c.symbol ? 'symbol ' + c.symbol : '', c.type === 'service' && c.instances ? c.instances + ' instances' : ''].filter(Boolean).join(' · ');
        if (extra) g += `<text class="k" x="${p.x + 14}" y="${p.y + 58}">${esc(extra)}</text>`;
      }
      g += `</g>`;
    });
    badges.forEach(([pt, n]) => { g += `<g class="badge"><circle cx="${pt[0]}" cy="${pt[1]}" r="10"/><text x="${pt[0]}" y="${pt[1] + 4}" text-anchor="middle">${n}</text></g>`; });
    return g + '</svg>';
  }
  function diagramBlock(bp) {
    return `<div class="map">${drawSystem(bp, null, 'diagram')}</div>
      ${bp.diagram.steps.length ? `<ol class="steps">${bp.diagram.steps.map(s => `<li>${esc(s.text)}</li>`).join('')}</ol>` : ''}
      ${bp.diagram.notes ? `<p class="small muted" style="margin:0;max-width:80ch">${esc(bp.diagram.notes)}</p>` : ''}
      <p class="small muted" style="margin:0">Solid arrows: business flow. Dashed: a service reads from a database or reference data. Dotted: an issuer publishes to reference data.</p>`;
  }

  // ------------------------------------------------------------ charts
  function spark(arr) {
    const pts = arr.slice(-60); if (pts.length < 2) return '<svg viewBox="0 0 100 34"></svg>';
    const max = Math.max(...pts), min = Math.min(...pts), rng = max - min || 1;
    const xy = pts.map((v, i) => [i / (pts.length - 1) * 100, 31 - ((v - min) / rng) * 27]);
    const line = xy.map(p => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ');
    const last = xy[xy.length - 1];
    return `<svg viewBox="0 0 100 34" preserveAspectRatio="none" aria-hidden="true"><polygon class="spark-a" points="0,34 ${line} 100,34"/><polyline class="spark-l" points="${line}" vector-effect="non-scaling-stroke"/><circle class="spark-d" cx="${last[0]}" cy="${last[1]}" r="2.2" vector-effect="non-scaling-stroke"/></svg>`;
  }
  function niceMax(v) { if (v <= 0) return 1; const e = Math.pow(10, Math.floor(Math.log10(v))); const f = v / e; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * e; }
  function panel(title, values, ts, opts) { // Grafana-style time series panel
    opts = opts || {};
    const W = 420, H = 150, pl = 44, pr = 10, pt = 10, pb = 22;
    const v = values.slice(-60), t = ts.slice(-60);
    const now = v.length ? v[v.length - 1] : 0;
    const top = niceMax(Math.max(...v, opts.thr || 0, 1) * 1.1);
    const x = i => pl + (v.length < 2 ? 0 : i / (v.length - 1)) * (W - pl - pr), y = val => pt + (1 - val / top) * (H - pt - pb);
    let g = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}">`;
    [0, 0.5, 1].forEach(f => { const val = top * f; g += `<line class="grid" x1="${pl}" x2="${W - pr}" y1="${y(val)}" y2="${y(val)}"/><text class="ax" x="${pl - 6}" y="${y(val) + 4}" text-anchor="end">${opts.fmt ? opts.fmt(val) : S.fmtInt(val)}</text>`; });
    for (let i = 0; i < t.length - 5; i += 10) g += `<text class="ax" x="${x(i)}" y="${H - 6}" text-anchor="middle">${S.clockStr(t[i])}</text>`;
    if (t.length) g += `<text class="ax" x="${x(t.length - 1)}" y="${H - 6}" text-anchor="end">${S.clockStr(t[t.length - 1])}</text>`;
    if (typeof opts.thr === 'number') g += `<line class="thr" x1="${pl}" x2="${W - pr}" y1="${y(opts.thr)}" y2="${y(opts.thr)}"/>`;
    if (v.length > 1) {
      const line = v.map((val, i) => `${x(i).toFixed(1)},${y(val).toFixed(1)}`).join(' ');
      g += `<polygon class="area" points="${x(0)},${y(0)} ${line} ${x(v.length - 1)},${y(0)}"/><polyline class="ln" points="${line}"/><circle class="dot" cx="${x(v.length - 1)}" cy="${y(now)}" r="3"/>`;
    }
    g += '</svg>';
    const over = typeof opts.thr === 'number' && (opts.below ? now < opts.thr : now > opts.thr);
    return `<div class="gpanel"><div class="row between"><span class="gtitle">${esc(title)}</span><span class="gval${over ? ' over' : ''}">${opts.fmt ? opts.fmt(now) : S.fmtInt(now)}</span></div>${g}</div>`;
  }

  // ------------------------------------------------------------ tool views
  function grafanaBody() {
    const sim = A.sim, ts = sim.history.t, bp = A.bp;
    const rule = (id, m) => bp.alerts.find(a => a.on === id && a.metric === m);
    if (A.grafana === 'overview') {
      const k = bp.business.kpis.find(x => x.cutoff);
      let out = k ? panel(`${k.label} (${bp.business.currency} ${bp.business.unit})`, sim.history.cut || [], ts, { fmt: v => S.fmtInt(v) }) : '';
      bp.components.filter(c => ['service', 'external_party', 'kafka_topic'].includes(c.type)).forEach(c => {
        const m = c.type === 'kafka_topic' ? 'lag' : 'out_rate';
        out += panel(`${c.name}: ${S.TYPES[c.type].metrics[m].toLowerCase()}`, sim.c[c.id].hist[m] || [], ts, { thr: rule(c.id, m) ? (rule(c.id, m).above ?? rule(c.id, m).below) : undefined, below: rule(c.id, m) && typeof rule(c.id, m).below === 'number' });
      });
      return out;
    }
    const c = bp.byId[A.grafana]; if (!c) return '';
    return Object.entries(S.TYPES[c.type].metrics).map(([m, label]) => {
      const r = rule(c.id, m);
      return panel(label, sim.c[c.id].hist[m] || [], ts, { thr: r ? (r.above ?? r.below) : undefined, below: r && typeof r.below === 'number', fmt: v => fmtMetric(m, v) });
    }).join('');
  }
  function resultTable(r) {
    if (!r) return '';
    if (r.error) return `<p class="err-box">${esc(r.error)}</p>`;
    const cols = r.cols, rows = r.rows;
    return `<div class="tablewrap res"><table><thead><tr>${cols.map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${rows.length ? rows.map(row => `<tr>${row.map(v => `<td class="mono">${v === null || v === undefined ? '<span class="muted">null</span>' : esc(v)}</td>`).join('')}</tr>`).join('') : `<tr><td colspan="${cols.length}" class="muted">no rows selected</td></tr>`}</tbody></table></div><p class="small muted" style="margin:4px 0 0">${rows.length} row${rows.length === 1 ? '' : 's'}</p>`;
  }
  function splunkBody() {
    const r = A.splunkR;
    if (!r) return '<p class="small muted" style="margin:0">Search every component\'s logs. Results reflect the moment you run the search.</p>';
    if (r.error) return `<p class="err-box">${esc(r.error)}</p>`;
    const max = Math.max(1, ...r.hist.map(h => h.n)), bw = 400 / r.hist.length;
    const hist = `<svg viewBox="0 0 420 70" class="hist" role="img" aria-label="Events per minute">${r.hist.map((h, i) => `<rect class="hb" x="${10 + i * bw}" y="${58 - h.n / max * 50}" width="${bw - 2}" height="${h.n / max * 50}"/><rect class="hbe" x="${10 + i * bw}" y="${58 - h.err / max * 50}" width="${bw - 2}" height="${h.err / max * 50}"/>`).join('')}<text class="ax" x="10" y="69">${r.hist[0].label}</text><text class="ax" x="410" y="69" text-anchor="end">${r.hist[r.hist.length - 1].label}</text></svg>`;
    return `<p class="small" style="margin:0"><b>${S.fmtInt(r.count)}</b> events · run at ${esc(r.at)}</p>${hist}${r.table ? resultTable(r.table) : ''}
      <div class="term" style="height:220px">${r.events.length ? r.events.map(l => `<span class="${l.level[0]}">${esc(l.line)}</span>`).join('\n') : 'No matching events.'}</div>`;
  }
  const SPLUNK_EXAMPLES = ['level=ERROR earliest=-15m | stats count by component', 'level=ERROR | top pattern', 'rejected | stats count by component', 'level=WARN OR level=ERROR | timechart count'];
  function sqlExamples() {
    const ex = ['SHOW TABLES', 'SELECT sid, program, status, seconds_in_call, connections_held FROM v$session ORDER BY connections_held DESC'];
    if (A.bp.components.some(c => c.type === 'source' && /FIX|Broker|Market/i.test((c.role || '') + c.name)) || A.bp.components.filter(c => c.type === 'source').length > 2) ex.push('SELECT * FROM sessions');
    ex.push('SELECT key, count(*) FROM rejects GROUP BY key');
    if (A.bp.components.some(c => c.type === 'issuer')) ex.push("SELECT * FROM corporate_actions WHERE status = 'SKIPPED'");
    const ref = A.bp.components.find(c => c.type === 'ref_data'); if (ref) ex.push(`SELECT * FROM ${ref.id}_load_log LIMIT 5`);
    return ex;
  }
  function unixExamples() {
    const h = TL.hosts(A.sim).find(x => x.host === A.unixHost); if (!h) return [];
    const c = A.sim.c[h.comp];
    const ex = ['help', `tail -n 30 /var/log/app/${h.comp}.log`, `grep ERROR /var/log/app/${h.comp}.log | wc -l`];
    if (c.type === 'service') ex.push('kubectl get pods', 'curl -s localhost:8080/health');
    if (c.type === 'kafka_topic') ex.push(`kafka-consumer-groups.sh --describe --group ${c.def.consumer_group || 'consumers'}`);
    if (c.type === 'database') ex.push('ps aux', 'free -m');
    ex.push('cat /etc/app/application.yml');
    return ex;
  }
  function toolsPanel() {
    const tabs = [['component', 'Component'], ['grafana', 'Grafana'], ['splunk', 'Splunk'], ['sql', 'Database'], ['unix', 'Unix']];
    let body = '';
    if (A.toolTab === 'component') body = `<div class="row between"><div><h3 id="insTitle"></h3><span class="small muted" id="insType"></span></div></div>
      <div class="tiles" id="tiles"></div>
      <div class="row between"><span class="label">Logs</span><label class="small row" style="gap:6px"><input type="checkbox" id="errOnly" ${A.errorsOnly ? 'checked' : ''}> Warnings and errors only</label></div>
      <div class="term" id="logs" tabindex="0" aria-label="Component logs"></div>`;
    if (A.toolTab === 'grafana') body = `<div class="row"><label class="small muted row" style="gap:6px">Dashboard<select id="gDash">${['overview', ...A.bp.components.filter(c => c.type !== 'issuer').map(c => c.id)].map(id => `<option value="${id}"${A.grafana === id ? ' selected' : ''}>${id === 'overview' ? 'Business and throughput overview' : esc(A.bp.byId[id].name)}</option>`).join('')}</select></label><span class="small muted">Last 60 minutes · dashed line = alert threshold</span></div><div class="ggrid" id="gBody"></div>`;
    if (A.toolTab === 'splunk') body = `<form class="row" id="spForm"><input type="text" id="spQ" class="mono grow" value="${esc(A.splunkQ)}" aria-label="Search query" autocomplete="off"><button class="btn primary">Search</button></form>
      <div class="chips">${SPLUNK_EXAMPLES.map(q => `<button type="button" class="chip" data-sq="${esc(q)}">${esc(q)}</button>`).join('')}</div>
      <p class="small muted" style="margin:0">Fields: <code>component=</code> <code>level=</code> <code>earliest=-15m</code>, <code>"phrases"</code>, <code>NOT</code>. Commands: <code>stats count by component|level|pattern</code>, <code>top pattern</code>, <code>timechart count</code>, <code>head 20</code>.</p>
      <div id="spBody" class="stack" style="gap:8px">${splunkBody()}</div>`;
    if (A.toolTab === 'sql') body = A.sqlDb ? `<div class="row"><label class="small muted row" style="gap:6px">Connection<select id="sqlDb">${A.bp.components.filter(c => c.type === 'database').map(c => `<option value="${c.id}"${A.sqlDb === c.id ? ' selected' : ''}>${esc(c.name)} (read-only)</option>`).join('')}</select></label></div>
      <textarea id="sqlQ" class="code sql" spellcheck="false" aria-label="SQL statement">${esc(A.sqlQ)}</textarea>
      <div class="row"><button class="btn primary" id="sqlRun">Run query</button><span class="small muted">Read-only. Changes go through approved actions.</span></div>
      <div class="chips">${sqlExamples().map(q => `<button type="button" class="chip" data-sql="${esc(q)}">${esc(q.length > 60 ? q.slice(0, 58) + '…' : q)}</button>`).join('')}</div>
      <div id="sqlBody">${resultTable(A.sqlR)}</div>` : '<p class="muted">This system has no database.</p>';
    if (A.toolTab === 'unix') body = `<div class="row"><label class="small muted row" style="gap:6px">Host<select id="uxHost">${TL.hosts(A.sim).map(h => `<option value="${h.host}"${A.unixHost === h.host ? ' selected' : ''}>${h.host}</option>`).join('')}</select></label><span class="small muted">Read-only support account. Participants' and vendors' own servers are not reachable.</span></div>
      <div class="term" id="uxOut" style="height:300px">${A.unixOut.map(x => esc(x)).join('\n') || 'Type help to see available commands.'}</div>
      <form class="row" id="uxForm"><span class="mono small">support_ro@${esc(A.unixHost)}:~$</span><input type="text" id="uxIn" class="mono grow" autocomplete="off" aria-label="Shell command"><button class="btn">Run</button></form>
      <div class="chips">${unixExamples().map(q => `<button type="button" class="chip" data-ux="${esc(q)}">${esc(q)}</button>`).join('')}</div>`;
    return `<section class="panel stack"><div class="tabs2" role="tablist">${tabs.map(([k, l]) => `<button role="tab" data-tool="${k}" aria-selected="${A.toolTab === k}">${l}</button>`).join('')}</div>${body}</section>`;
  }

  // ------------------------------------------------------------ live refresh
  function drawInspector() {
    const id = A.selected, s = A.sim.c[id]; if (!s || !$('#tiles')) return;
    const h = A.sim.health(id);
    $('#insTitle').innerHTML = `${esc(s.def.name)} <span class="pill ${h === 'ok' ? 'ok' : h}">${h === 'ok' ? 'healthy' : h === 'warn' ? 'degraded' : 'critical'}</span>`;
    $('#insType').textContent = `${roleOf(s.def)} · ${S.TYPES[s.type].label} · id ${id}${s.def.uses ? ' · uses ' + s.def.uses.join(', ') : ''}${s.def.feeds ? ' · publishes to ' + s.def.feeds : ''}`;
    const M = S.TYPES[s.type].metrics;
    $('#tiles').innerHTML = Object.keys(M).map(m => `<div class="tile"><div class="label">${esc(M[m])}</div><div class="v">${fmtMetric(m, A.sim.metric(id, m))}</div>${spark(s.hist[m] || [])}</div>`).join('')
      + (s.type === 'kafka_topic' ? `<div class="tile"><div class="label">Lag by partition</div><div class="mono small">${s.parts.map((v, i) => `p${i}: ${S.fmtInt(v)}`).join('<br>')}</div></div>` : '');
    const term = $('#logs'), near = term.scrollHeight - term.scrollTop - term.clientHeight < 40;
    const logs = s.logs.filter(l => !A.errorsOnly || l.level !== 'INFO').slice(-150);
    term.innerHTML = logs.length ? logs.map(l => `<span class="${l.level[0]}">${esc(l.line)}</span>`).join('\n') : (s.type === 'issuer' ? 'No logs: the exchange cannot see inside a listed company. Look at the systems that use its data.' : s.type === 'source' ? 'Only connection events are visible for a participant.' : 'No log lines yet.');
    if (near) term.scrollTop = term.scrollHeight;
  }
  function updateLive() {
    const sim = A.sim; if (!sim) return;
    $('#clock').textContent = sim.time(true);
    const left = Math.round((A.bp.cutoff - sim.t) / 60);
    $('#cutoff').textContent = `${A.bp.clockLabel} ${S.clockStr(A.bp.cutoff)} · ${left > 0 ? left + ' min left' : 'passed'}`;
    const risk = sim.cutoffRisk().atRisk;
    $('#kpis').innerHTML = sim.kpis().map(k => {
      const cls = k.trades > A.bp.business.tolerance_trades ? (k.cutoff && risk ? 'bad' : 'warn') : '';
      return `<div class="kpi"><span class="label">${esc(k.label)}</span><span class="v ${cls}">${money(k.notional)}</span><span class="small muted mono">${S.fmtInt(k.trades)} ${esc(A.bp.business.unit_name)}</span></div>`;
    }).join('');
    $('#sysName').textContent = A.bp.system;
    const chip = $('#stateChip');
    chip.className = 'state-chip' + (A.session ? ' live' : '');
    chip.textContent = A.session ? `Drill: ${A.session.drill.title}` : A.ended ? 'Drill ended' : 'Sandbox';
    $('#pauseBtn').textContent = A.running ? 'Pause' : 'Resume';
    $('#pauseBtn').disabled = !!A.ended;
    if (A.tab !== 'run') return;
    if (A.mapView === 'live') $('#map').innerHTML = drawSystem(A.bp, sim, 'live');
    if (A.toolTab === 'component') drawInspector();
    if (A.toolTab === 'grafana' && $('#gBody')) $('#gBody').innerHTML = grafanaBody();
    const firing = sim.alerts.filter(a => a.status === 'FIRING').length;
    $('#alertCount').textContent = firing ? `${firing} firing` : 'none firing';
    $('#alerts').innerHTML = sim.alerts.length ? sim.alerts.slice().sort((a, b) => (a.status === 'FIRING' ? 0 : 1) - (b.status === 'FIRING' ? 0 : 1) || b.firedAt - a.firedAt).map(a =>
      `<button class="alert${a.status === 'RESOLVED' ? ' resolved' : ''}" data-alert-on="${esc(a.on)}"><span class="pill ${a.severity === 'P1' ? 'bad' : a.severity === 'P2' ? 'warn' : 'mut'}">${a.severity}</span><span>${esc(a.name)}<br><span class="small muted">${esc(sim.c[a.on] ? sim.c[a.on].def.name : a.on)}${a.threshold ? ' · ' + esc(a.threshold) : ''} · ${esc(a.source)}</span></span><span class="when">${S.clockStr(a.firedAt)}${a.status === 'RESOLVED' ? '<br>resolved' : ''}</span></button>`).join('')
      : '<p class="small muted" style="margin:0">No alerts. Alert rules come from the system blueprint.</p>';
    if (A.session) {
      const ss = A.session;
      $('#ackStatus').textContent = ss.ackAt === null ? 'Not acknowledged' : `Acknowledged at ${S.clockStr(ss.ackAt)} by ${ss.ackBy}`;
      $('#ackBtn').disabled = ss.ackAt !== null;
      $('#hints').innerHTML = ss.visibleHints().map(h => `<div class="hint">${esc(h)}</div>`).join('');
    }
  }

  // ------------------------------------------------------------ views
  function renderAll() {
    document.querySelectorAll('.tabs button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === A.tab)));
    $('#main').innerHTML = ({ drills: viewDrills, run: viewRun, design: viewDesign, debrief: viewDebrief }[A.tab])();
    wire(); updateLive();
  }

  function viewDrills() {
    const list = drillsFor(A.bp), sel = findDrill(A.drillId), running = !!A.session;
    const counts = sys => ({ p: sys.bp.components.filter(c => c.type === 'source').length, n: sys.bp.components.length, u: drillsFor(sys.bp).length });
    return `<div class="stack">
      <section class="panel stack"><div><h2>1. Choose a system</h2><p class="muted small" style="margin:2px 0 0">Each system has its own architecture and its own use cases. Design new ones in the Design tab.</p></div>
        <div class="lib">${Object.entries(SYSTEMS).map(([id, sys]) => { const k = counts(sys); return `<button class="card" data-sys="${id}" aria-pressed="${id === A.sysId}" ${running ? 'disabled' : ''}>
          <div class="row between"><span class="pill ${sys.builtIn ? 'info' : 'mut'}">${sys.builtIn ? 'Built in' : 'Your design'}</span><span class="small muted">${k.u} use case${k.u === 1 ? '' : 's'}</span></div>
          <h3>${esc(sys.bp.system)}</h3><span class="small muted">${esc(shortName(sys.bp.description, 170))}</span>
          <span class="small mono muted">${k.n} components · ${k.p} participant${k.p === 1 ? '' : 's'} · ${S.clockStr(sys.bp.start)}–${S.clockStr(sys.bp.cutoff)}</span></button>`; }).join('')}</div>
        ${running ? '<p class="small muted" style="margin:0">A drill is running. End it to change system.</p>' : ''}
      </section>
      <section class="panel stack"><div class="row between"><h2>Flow diagram: ${esc(A.bp.system)}</h2><span class="small muted">Read this before you start. It stays available during the drill.</span></div>${diagramBlock(A.bp)}</section>
      <section class="panel stack"><h2>2. Choose a use case</h2>
        <div class="setup">
          <label class="field">Your name (shown on acknowledgements)<input type="text" id="responder" value="${esc(A.responder)}" placeholder="e.g. Priya, L2 Support" autocomplete="off"></label>
          <label class="field">Mode<select id="mode"><option value="practice"${A.mode === 'practice' ? ' selected' : ''}>Practice: hints and feedback</option><option value="assessment"${A.mode === 'assessment' ? ' selected' : ''}>Assessment: no hints</option></select></label>
          <label class="field">Speed<select id="speedSel">${[1, 2, 4, 8].map(x => `<option value="${x}"${A.speed === x ? ' selected' : ''}>${x}× (1 s = ${x * 10} s)</option>`).join('')}</select></label>
          <button class="btn primary" id="startBtn" ${!sel || D.validateDrill(sel.d, A.bp).length ? 'disabled' : ''}>${sel ? `Start “${esc(sel.d.title)}”` : 'No use case'}</button>
        </div>
        <div class="lib">${list.map(({ d, builtIn }) => {
          const errs = D.validateDrill(d, A.bp);
          return `<button class="card" data-drill="${esc(d.id)}" aria-pressed="${d.id === A.drillId}" ${errs.length ? 'disabled' : ''}>
            <div class="row between"><span class="pill ${d.level === 'Easy' ? 'ok' : d.level === 'Medium' ? 'warn' : 'bad'}">${esc(d.level || 'Custom')}</span><span class="small muted">${d.mystery ? 'random fault' : builtIn ? '' : 'your use case'}</span></div>
            <h3>${esc(d.title)}</h3><span class="small muted">${esc(d.summary || '')}</span>
            ${errs.length ? `<span class="small" style="color:var(--bad)">${esc(errs[0])}</span>` : ''}</button>`;
        }).join('') || '<p class="muted">No use cases for this system yet. Add one in the Design tab.</p>'}</div>
        ${sel ? `<details><summary class="label" style="cursor:pointer">Use case file: ${esc(sel.d.id)}.yaml</summary><pre class="term" style="height:auto;max-height:420px">${esc(sel.text)}</pre></details>` : ''}
      </section></div>`;
  }

  function compOptions(filter) { return A.bp.components.filter(filter).map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join(''); }
  function actionPicker() {
    return `<div class="stack" style="gap:6px"><span class="label">Request an action</span>
      <div class="pick"><select id="acComp" aria-label="Component">${compOptions(c => Object.keys(S.TYPES[c.type].actions).length)}</select><select id="acAction" aria-label="Action"></select><button class="btn" id="acBtn">Request approval</button></div>
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
  const feedHtml = () => A.feed.slice(-12).reverse().map(f => `<div class="${f.cls || ''}"><span class="mono muted">${f.t}</span> ${esc(f.text)}</div>`).join('');
  function pushFeed(text, cls) { A.feed.push({ t: A.sim.time(), text, cls }); const el = $('#feed'); if (el) el.innerHTML = feedHtml(); }

  function viewRun() {
    const ss = A.session;
    const side = ss ? `
      <section class="panel stack"><div class="row between"><h2>Briefing</h2><span class="pill ${ss.mode === 'practice' ? 'info' : 'mut'}">${ss.mode}</span></div>
        <p class="brief" style="margin:0">${esc(ss.drill.brief)}</p><div id="hints" class="stack" style="gap:6px"></div></section>
      <section class="panel stack"><h2>Respond</h2>
        <div class="row between"><span id="ackStatus" class="small muted"></span><button class="btn" id="ackBtn">Acknowledge</button></div>
        <div class="stack" style="gap:6px"><span class="label">Declare root cause</span>
          <div class="pick"><select id="rcComp" aria-label="Component">${compOptions(c => Object.keys(S.TYPES[c.type].faults).length)}</select><select id="rcFault" aria-label="Fault"></select><button class="btn" id="rcBtn">Declare</button></div></div>
        ${actionPicker()}
        <div class="feed" id="feed">${feedHtml()}</div>
        <button class="btn" id="endBtn">End drill and see debrief</button>
      </section>` : `
      <section class="panel stack"><h2>Sandbox</h2>
        <p class="small muted" style="margin:0">${A.ended ? 'The drill has ended and the system is frozen at that moment. Inspect it, or reset to start a fresh sandbox.' : `Free play on <b>${esc(A.bp.system)}</b>. Break any component and investigate with the tools, or start a scored use case from the Drills tab.`}</p>
        <div class="stack" style="gap:6px"><span class="label">Break something</span>
          <div class="pick"><select id="fxComp" aria-label="Component">${compOptions(c => Object.keys(S.TYPES[c.type].faults).length)}</select><select id="fxFault" aria-label="Fault"></select><button class="btn danger" id="fxBtn" ${A.ended ? 'disabled' : ''}>Inject fault</button></div></div>
        ${actionPicker()}
        <div class="feed" id="feed">${feedHtml()}</div>
        <button class="btn" id="resetBtn">Reset sandbox to healthy</button>
      </section>`;
    return `<div class="run">
        <section class="panel stack wide"><div class="row between"><div class="tabs2" role="tablist"><button role="tab" data-map="live" aria-selected="${A.mapView === 'live'}">Live map</button><button role="tab" data-map="diagram" aria-selected="${A.mapView === 'diagram'}">Flow diagram</button></div>
          <span class="small muted">${A.mapView === 'live' ? 'Click a component to inspect it.' : 'Numbered steps follow the business flow.'}</span></div>
          ${A.mapView === 'live' ? '<div class="map" id="map"></div>' : diagramBlock(A.bp)}</section>
      <div class="stack">${toolsPanel()}</div>
      <div class="stack">${side}
        <section class="panel stack"><div class="row between"><h2>Alerts</h2><span class="small muted" id="alertCount"></span></div><div class="alerts" id="alerts"></div></section>
      </div></div>`;
  }

  function ucTemplate(bp) {
    const fc = bp.components.find(c => c.type === 'service' && Object.keys(S.TYPES.service.faults).length) || bp.components.find(c => Object.keys(S.TYPES[c.type].faults).length);
    const fault = Object.keys(S.TYPES[fc.type].faults)[0], action = Object.entries(S.TYPES[fc.type].actions).find(([, a]) => a.fixes.includes(fault));
    return `id: my-use-case
title: My use case
systems: [${bp.id}]
level: Medium
summary: One line shown on the use case card.
brief: >
  What the responder is told at ${S.clockStr(bp.start)}. Describe the situation, not the cause.
faults:
  - {at: "${S.clockStr(bp.start + 360)}", component: ${fc.id}, fault: ${fault}}
root_cause: {component: ${fc.id}, fault: ${fault}}
accepted_fixes: [${fc.id}.${action ? action[0] : Object.keys(S.TYPES[fc.type].actions)[0]}]
risky_actions: []
hints:
  - {after_min: 3, text: "A nudge shown in practice mode after 3 minutes."}
debrief:
  what_happened: What really happened, explained after the drill.
  key_signal: The signal a good responder spots first.
  runbook:
    - First step of the runbook
    - Second step
`;
  }
  function viewDesign() {
    const sysText = A.designSys != null ? A.designSys : SYSTEMS[A.sysId].text;
    const ucText = A.designUC != null ? A.designUC : ucTemplate(A.bp);
    const comps = A.bp.components.filter(c => Object.keys(S.TYPES[c.type].faults).length || Object.keys(S.TYPES[c.type].actions).length);
    return `<div class="stack">
      <div class="bp">
        <section class="panel stack"><div><h2>1. Design a system</h2><p class="small muted" style="margin:2px 0 0">Components, the flow between them, alert rules and the flow diagram. ${A.session ? '<b>Loading ends the current drill.</b>' : ''}</p><p class="small" style="margin:4px 0 0">Prefer forms to YAML? Use the <a href="builder.html">System Builder</a> (the <code>builder.html</code> file next to this one) to add components and copy the YAML here.</p></div>
          <div class="row"><label class="row small" style="gap:6px">Start from<select id="preset">${Object.entries(SYSTEMS).map(([id, s]) => `<option value="${id}"${id === A.sysId ? ' selected' : ''}>${esc(s.bp.system)}</option>`).join('')}</select></label></div>
          <textarea class="code" id="bpText" spellcheck="false" aria-label="System blueprint YAML">${esc(sysText)}</textarea>
          <div class="row"><button class="btn" id="bpCheck">Check</button><button class="btn primary" id="bpLoad">Save and load system</button><button class="btn" id="bpCopy">Copy YAML</button></div>
          <div id="bpMsg">${A.designMsg}</div>
        </section>
        <section class="panel stack"><div><h2>2. Add a use case to “${esc(A.bp.system)}”</h2><p class="small muted" style="margin:2px 0 0">A use case is a drill: the fault, when it starts, the right answer and the debrief. It appears under this system in the Drills tab.</p></div>
          <div class="row"><label class="row small" style="gap:6px">Start from<select id="ucPreset"><option value="">Blank template</option>${drillsFor(A.bp).map(({ d }) => `<option value="${esc(d.id)}">${esc(d.title)}</option>`).join('')}</select></label></div>
          <textarea class="code" id="ucText" spellcheck="false" aria-label="Use case YAML">${esc(ucText)}</textarea>
          <div class="row"><button class="btn" id="ucCheck">Check</button><button class="btn primary" id="ucAdd">Save use case</button><button class="btn" id="ucCopy">Copy YAML</button></div>
          <div id="ucMsg">${A.ucMsg}</div>
          <p class="small muted" style="margin:0">Saved designs live in this browser. To keep them in the project, copy the YAML into <code>blueprints/</code> or <code>drills/</code> and rebuild.</p>
        </section>
      </div>
      <section class="panel stack"><h2>What can fail in “${esc(A.bp.system)}”, and how it is fixed</h2>
        <div class="tablewrap"><table><thead><tr><th>Component id</th><th>Name</th><th>Faults (<code>fault:</code>)</th><th>Actions (<code>component.action</code>)</th></tr></thead><tbody>
        ${comps.map(c => `<tr><td><code>${c.id}</code></td><td>${esc(c.name)}</td><td class="small">${Object.entries(S.TYPES[c.type].faults).map(([k, f]) => `<code>${k}</code> ${esc(f.label)}`).join('<br>') || '—'}</td><td class="small">${Object.entries(S.TYPES[c.type].actions).map(([k, a]) => `<code>${c.id}.${k}</code>${a.fixes.length ? ' fixes ' + a.fixes.map(f => `<code>${f}</code>`).join(', ') : ''}`).join('<br>') || '—'}</td></tr>`).join('')}
        </tbody></table></div></section>
      <section class="panel stack"><h2>Component types</h2>
        <div class="tablewrap"><table><thead><tr><th>Type</th><th>Settings</th><th>Metrics for alert rules</th></tr></thead><tbody>${Object.entries(S.TYPES).map(([k, T]) => `<tr><td><code>${k}</code></td><td class="small">${T.required.map(r => `<code>${r}</code>`).join(' ')}${k === 'service' ? ' <span class="muted">optional <code>instances</code> <code>uses</code> <code>rejects: queue|return</code></span>' : ''}${k === 'source' ? ' <span class="muted">optional <code>role</code> <code>session</code></span>' : ''}${k === 'kafka_topic' ? ' <span class="muted">optional <code>consumer_group</code></span>' : ''}${k === 'issuer' ? '<code>feeds</code> <span class="muted">optional <code>symbol</code></span>' : ''}</td><td class="small">${Object.keys(T.metrics).map(m => `<code>${m}</code>`).join(' ')}</td></tr>`).join('')}</tbody></table></div>
        <p class="small muted" style="margin:0">Flow lines join components with <code>-&gt;</code>; a component may appear in several lines (many members into one gateway, one matching engine out to clearing and market data). Databases and reference data attach with <code>uses</code>; issuers attach with <code>feeds</code>. The <code>diagram</code> section sets groups, numbered steps and positions as <code>[column, row]</code>.</p></section>
    </div>`;
  }

  function viewDebrief() {
    const d = A.debrief;
    if (!d) return `<div class="panel empty">Finish a drill to see its debrief here.</div>`;
    const sc = d.score, t = sc.times, n = d.notes || {};
    const tm = v => v === null || v === undefined ? '—' : v + ' min';
    const reason = { recovered: 'Business flow recovered', cutoff: `${A.bp.clockLabel} reached`, abandoned: 'Ended by responder' }[A.debriefReason || 'abandoned'];
    return `<div class="stack">
      <section class="panel score"><div><div class="big">${sc.total}</div><div class="label">of 100 · ${esc(sc.grade)}</div></div>
        <div class="stack" style="gap:6px"><h2>${esc(d.drill.title)}</h2><span class="small muted">${esc(A.bp.system)} · ${esc(d.mode)} mode · ${esc(reason)}</span>
          <div class="parts">${sc.parts.map(p => `<div class="part"><span>${esc(p.label)}</span><div class="track"><div class="fill" style="width:${p.pts / p.max * 100}%"></div></div><span class="mono">${p.pts}/${p.max}</span><span class="note">${esc(p.note)}</span></div>`).join('')}</div></div></section>
      <div class="times">${[['Fault started', S.clockStr(t.fault)], ['Time to detect', tm(t.detect)], ['Time to acknowledge', tm(t.mtta)], ['Time to diagnose', tm(t.diagnose)], ['Time to recover', tm(t.recover)]].map(([l, v]) => `<div class="panel"><div class="label">${l}</div><div class="mono" style="font-size:18px">${v}</div></div>`).join('')}</div>
      <div class="bp">
        <section class="panel stack"><h2>What happened</h2>
          <p style="margin:0"><b>Root cause:</b> ${esc(d.answer.fault)} on ${esc(d.answer.component)}.</p>
          ${n.what_happened ? `<p style="margin:0">${esc(n.what_happened)}</p>` : ''}
          ${n.key_signal ? `<p style="margin:0"><b>The signal to spot:</b> ${esc(n.key_signal)}</p>` : ''}
          ${n.why_not_restart ? `<p style="margin:0"><b>Why not just restart:</b> ${esc(n.why_not_restart)}</p>` : ''}
          <p style="margin:0"><b>Accepted fix:</b> ${esc(d.accepted.join(' or '))}.</p>
          ${n.runbook ? `<h3>Runbook</h3><ol style="margin:0;padding-left:20px">${n.runbook.map(r => `<li>${esc(r)}</li>`).join('')}</ol>` : ''}
          <h3>Your decisions</h3>
          ${d.declarations.length ? `<ul style="margin:0;padding-left:20px">${d.declarations.map(x => `<li><span class="mono">${S.clockStr(x.t)}</span> Declared ${esc(x.label)} <span class="cls ${x.correct ? 'accepted' : 'risky'}">${x.correct ? 'correct' : 'incorrect'}</span></li>`).join('')}</ul>` : '<p class="small muted" style="margin:0">No root cause declared.</p>'}
          ${d.actions.length ? `<ul style="margin:0;padding-left:20px">${d.actions.map(x => `<li><span class="mono">${S.clockStr(x.t)}</span> ${esc(x.label)} on ${esc(A.bp.byId[x.component] ? A.bp.byId[x.component].name : x.component)}, approved by ${esc(x.approver)} <span class="cls ${x.cls}">${x.cls}</span></li>`).join('')}</ul>` : '<p class="small muted" style="margin:0">No actions taken.</p>'}
          <h3>How you investigated</h3>
          <p class="small" style="margin:0">Components inspected: ${d.inspected.length ? esc(d.inspected.join(', ')) : 'none'}.</p>
          ${d.tools.length ? `<ul class="small" style="margin:0;padding-left:20px">${d.tools.map(x => `<li><span class="mono">${S.clockStr(x.t)}</span> ${esc(x.tool)}: <code>${esc(x.detail)}</code></li>`).join('')}</ul>` : '<p class="small muted" style="margin:0">No Grafana, Splunk, database or shell use recorded.</p>'}
        </section>
        <section class="panel stack"><h2>Timeline</h2><ul class="tl">${d.timeline.map(e => `<li class="k-${e.kind}"><time>${S.clockStr(e.t)}</time><span>${esc(e.text)}</span></li>`).join('')}</ul></section>
      </div>
      <div class="row"><button class="btn primary" id="againBtn">Run this use case again</button><button class="btn" id="otherBtn">Choose another use case</button></div>
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
  const errList = errs => `<ul class="errors">${errs.map(x => `<li>${esc(x)}</li>`).join('')}</ul>`;
  function copyText(text, btn) {
    const done = () => { btn.textContent = 'Copied'; setTimeout(() => { btn.textContent = 'Copy YAML'; }, 1500); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, () => toast('Copy blocked here. Select the text and copy it instead.'));
    else toast('Copy blocked here. Select the text and copy it instead.');
  }
  function checkUseCase(text) {
    let d; try { d = yaml.load(text); } catch (e) { return { errors: ['YAML syntax: ' + (e.reason || e.message) + (e.mark ? ` (line ${e.mark.line + 1})` : '')] }; }
    if (!d || typeof d !== 'object') return { errors: ['The use case is empty.'] };
    const errs = D.validateDrill(d, A.bp);
    if (!d.id || !/^[a-z0-9][a-z0-9-]*$/.test(String(d.id))) errs.unshift('"id" must be lowercase letters, digits and dashes, e.g. my-use-case.');
    if (BUILTIN_DRILLS.some(x => x.d.id === d.id)) errs.unshift(`"${d.id}" is a built-in use case id. Choose a new id.`);
    if (!Array.isArray(d.systems) || !d.systems.includes(A.bp.id)) errs.push(`"systems" must include ${A.bp.id} so the use case shows under this system.`);
    if (!d.root_cause) errs.push('Add "root_cause" (component and fault) so the responder can be scored.');
    if (!Array.isArray(d.accepted_fixes) || !d.accepted_fixes.length) errs.push('Add at least one "accepted_fixes" action.');
    return { errors: errs, d };
  }
  function wire() {
    const on = (sel, ev, fn) => { const el = $(sel); if (el) el.addEventListener(ev, fn); };
    const each = (sel, fn) => document.querySelectorAll(sel).forEach(fn);
    // drills
    each('[data-sys]', b => b.addEventListener('click', () => { useSystem(b.dataset.sys); renderAll(); }));
    each('[data-drill]', b => b.addEventListener('click', () => { A.drillId = b.dataset.drill; renderAll(); }));
    on('#responder', 'input', e => { A.responder = e.target.value; store.set('responder', A.responder); });
    on('#mode', 'change', e => { A.mode = e.target.value; store.set('mode', A.mode); });
    on('#speedSel', 'change', e => { A.speed = +e.target.value; $('#speed').value = String(A.speed); });
    on('#startBtn', 'click', startDrill);
    // run: map and inspector
    each('[data-map]', b => b.addEventListener('click', () => { A.mapView = b.dataset.map; if (A.mapView === 'diagram' && A.session) A.session.useTool('Flow diagram', 'opened'); renderAll(); }));
    on('#map', 'click', e => { const n = e.target.closest('[data-node]'); if (n) select(n.dataset.node); });
    on('#map', 'keydown', e => { const n = e.target.closest('[data-node]'); if (n && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); select(n.dataset.node); } });
    on('#alerts', 'click', e => { const b = e.target.closest('[data-alert-on]'); if (b && A.sim.c[b.dataset.alertOn]) select(b.dataset.alertOn); });
    on('#errOnly', 'change', e => { A.errorsOnly = e.target.checked; drawInspector(); });
    // tools
    each('[data-tool]', b => b.addEventListener('click', () => { A.toolTab = b.dataset.tool; if (A.toolTab === 'grafana' && A.session) A.session.useTool('Grafana', A.grafana === 'overview' ? 'overview dashboard' : A.bp.byId[A.grafana].name); renderAll(); }));
    on('#gDash', 'change', e => { A.grafana = e.target.value; if (A.session) A.session.useTool('Grafana', A.grafana === 'overview' ? 'overview dashboard' : A.bp.byId[A.grafana].name); updateLive(); });
    const runSplunk = q => { A.splunkQ = q; A.splunkR = TL.search(A.sim, q); A.splunkR.at = A.sim.time(true); if (A.session) A.session.useTool('Splunk', q); $('#spBody').innerHTML = splunkBody(); };
    on('#spForm', 'submit', e => { e.preventDefault(); runSplunk($('#spQ').value); });
    each('[data-sq]', b => b.addEventListener('click', () => { $('#spQ').value = b.dataset.sq; runSplunk(b.dataset.sq); }));
    const runSql = q => { A.sqlQ = q; A.sqlR = TL.sql(A.sim, A.sqlDb, q); if (A.session) A.session.useTool('SQL', q.replace(/\s+/g, ' ')); $('#sqlBody').innerHTML = resultTable(A.sqlR); };
    on('#sqlRun', 'click', () => runSql($('#sqlQ').value));
    on('#sqlQ', 'keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); runSql(e.target.value); } });
    on('#sqlDb', 'change', e => { A.sqlDb = e.target.value; A.sqlR = null; $('#sqlBody').innerHTML = ''; });
    each('[data-sql]', b => b.addEventListener('click', () => { $('#sqlQ').value = b.dataset.sql; runSql(b.dataset.sql); }));
    const runUnix = cmd => {
      if (!cmd.trim()) return;
      const out = TL.shell(A.sim, A.unixHost, cmd);
      A.unixOut.push(`support_ro@${A.unixHost}:~$ ${cmd}`, ...(out ? [out] : []));
      if (A.unixOut.length > 400) A.unixOut.splice(0, A.unixOut.length - 400);
      if (A.session) A.session.useTool('Shell', `${A.unixHost}$ ${cmd}`);
      const el = $('#uxOut'); el.textContent = A.unixOut.join('\n'); el.scrollTop = el.scrollHeight;
    };
    on('#uxForm', 'submit', e => { e.preventDefault(); const v = $('#uxIn').value; $('#uxIn').value = ''; runUnix(v); });
    on('#uxHost', 'change', e => { A.unixHost = e.target.value; A.unixOut.push(`--- connected to ${A.unixHost} ---`); renderAll(); });
    each('[data-ux]', b => b.addEventListener('click', () => runUnix(b.dataset.ux)));
    if ($('#uxOut')) $('#uxOut').scrollTop = $('#uxOut').scrollHeight;
    // run: response
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
    on('#fxBtn', 'click', () => { const comp = $('#fxComp').value, fault = $('#fxFault').value; A.sim.injectFault(comp, fault); pushFeed(`Injected: ${S.TYPES[A.bp.byId[comp].type].faults[fault].label} on ${A.bp.byId[comp].name}`, 'bad'); updateLive(); });
    on('#acBtn', 'click', () => { A.approval = { comp: $('#acComp').value, action: $('#acAction').value, name: '' }; $('#approval').innerHTML = approvalHtml(); wireApproval(); $('#apprName').focus(); });
    wireApproval();
    on('#endBtn', 'click', () => endDrill('abandoned'));
    on('#resetBtn', 'click', resetSandbox);
    // design: system
    on('#preset', 'change', e => { A.designSys = SYSTEMS[e.target.value].text; A.designMsg = ''; renderAll(); });
    on('#bpText', 'input', e => { A.designSys = e.target.value; });
    on('#bpCheck', 'click', () => {
      const r = S.parseBlueprint($('#bpText').value, yaml);
      A.designMsg = r.errors.length ? errList(r.errors) : `<span class="okmsg">Valid: ${r.blueprint.components.length} components, ${r.blueprint.edges.length} connections, ${r.blueprint.alerts.length} alert rules, ${r.blueprint.diagram.steps.length} diagram steps. Use cases that fit: ${allDrills().filter(x => D.drillFor(x.d, r.blueprint)).length}.</span>`;
      $('#bpMsg').innerHTML = A.designMsg;
    });
    on('#bpLoad', 'click', () => {
      const text = $('#bpText').value, r = S.parseBlueprint(text, yaml);
      if (r.errors.length) { A.designMsg = errList(r.errors); $('#bpMsg').innerHTML = A.designMsg; return; }
      const prev = SYSTEMS[r.blueprint.id];
      SYSTEMS[r.blueprint.id] = { text, bp: r.blueprint, builtIn: !!(prev && prev.builtIn && prev.text === text) };
      saveCustom();
      useSystem(r.blueprint.id);
      A.designSys = null; A.designMsg = ''; A.running = true; A.tab = 'drills'; renderAll(); toast(`Saved and loaded “${A.bp.system}”.`);
    });
    on('#bpCopy', 'click', e => copyText($('#bpText').value, e.target));
    // design: use case
    on('#ucPreset', 'change', e => { const x = findDrill(e.target.value); A.designUC = x ? x.text.replace(/^id: .*$/m, `id: ${x.d.id}-copy`).replace(/^title: (.*)$/m, 'title: $1 (copy)') : ucTemplate(A.bp); A.ucMsg = ''; renderAll(); });
    on('#ucText', 'input', e => { A.designUC = e.target.value; });
    on('#ucCheck', 'click', () => { const r = checkUseCase($('#ucText').value); A.ucMsg = r.errors.length ? errList(r.errors) : '<span class="okmsg">Valid. Save it to add it to this system.</span>'; $('#ucMsg').innerHTML = A.ucMsg; });
    on('#ucAdd', 'click', () => {
      const text = $('#ucText').value, r = checkUseCase(text);
      if (r.errors.length) { A.ucMsg = errList(r.errors); $('#ucMsg').innerHTML = A.ucMsg; return; }
      CUSTOM_DRILLS = CUSTOM_DRILLS.filter(x => x.d.id !== r.d.id); CUSTOM_DRILLS.push({ text, d: r.d, builtIn: false }); saveCustom();
      A.drillId = r.d.id; A.designUC = null; A.ucMsg = ''; A.tab = 'drills'; renderAll(); toast(`Use case “${r.d.title}” added to ${A.bp.system}.`);
    });
    on('#ucCopy', 'click', e => copyText($('#ucText').value, e.target));
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
  function select(id) { A.selected = id; if (A.session) A.session.inspect(id); if (A.toolTab !== 'component') { A.toolTab = 'component'; renderAll(); } else updateLive(); }

  let toastT;
  function toast(t) { const el = $('#toast'); el.textContent = t; el.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { el.hidden = true; }, 3200); }

  document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => { A.tab = b.dataset.tab; renderAll(); }));
  $('#pauseBtn').addEventListener('click', () => { A.running = !A.running; updateLive(); });
  $('#speed').addEventListener('change', e => { A.speed = +e.target.value; const s = $('#speedSel'); if (s) s.value = String(A.speed); });

  useSystem(A.sysId);
  renderAll();
  window.__drillApp = A; // exposed for automated tests
})();
