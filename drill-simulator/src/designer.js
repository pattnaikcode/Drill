/* OpsPilot Designer: build a system by dragging components onto a canvas.
 *
 * The designer edits the same YAML object the simulator reads (components, flow, uses/feeds, kinds,
 * diagram, alerts, KPIs, journeys). The canvas is just a view of it: positions are diagram.place,
 * arrows are flow lines (or "uses" / "feeds" links). After every change the engine's own validator
 * runs, and problems are shown on the boxes they belong to.
 */
(function () {
  'use strict';
  const S = window.OpsSim, yaml = window.jsyaml, C = window.DRILL_CONTENT;
  const $ = s => document.querySelector(s);
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  (C.packs || []).forEach(t => { try { S.registerPack(yaml.load(t)); } catch (e) { /* reported in the simulator */ } });

  // ------------------------------------------------------------ geometry (same grid as the simulator's diagram)
  const COL = 200, ROW = 112, BW = 164, BH = 70, PADX = 24, PADT = 44;
  const toPx = ([c, r]) => ({ x: PADX + c * COL, y: PADT + r * ROW });
  const toCell = (x, y) => [Math.max(0, Math.round((x - PADX) / COL * 20) / 20), Math.max(0, Math.round((y - PADT) / ROW * 20) / 20)];

  // ------------------------------------------------------------ what can be added
  const FLOW = ['source', 'service', 'kafka_topic', 'external_party'];
  const COLOR = { source: '#2E7DBA', service: '#1D7F52', kafka_topic: '#8A5CC2', external_party: '#A86300', database: '#5A6577', ref_data: '#B0436E', issuer: '#3B8C8C' };
  const BUILTIN = [
    { type: 'source', label: 'Participant', sub: 'Broker, market maker, channel, front office', group: 'Participants' },
    { type: 'service', label: 'Service', sub: 'Gateway, matching, any processing step', group: 'Processing' },
    { type: 'kafka_topic', label: 'Kafka topic', sub: 'Buffer with partitions and lag', group: 'Messaging' },
    { type: 'database', label: 'Database', sub: 'Used by a service (connection pool)', group: 'Data' },
    { type: 'ref_data', label: 'Reference data', sub: 'Loaded on a schedule; stale = rejects', group: 'Data' },
    { type: 'issuer', label: 'Issuer', sub: 'Publishes to reference data', group: 'Data' },
    { type: 'external_party', label: 'External party', sub: 'Clearing, vendor, outside our control', group: 'Outside' },
  ];
  const DEFAULTS = { source: { rate_per_min: 300 }, service: { capacity_per_min: 1000, instances: 2 }, kafka_topic: { partitions: 6 }, external_party: { capacity_per_min: 1200 }, database: { pool_size: 50 }, ref_data: { refresh_every_min: 15, stale_after_min: 30 }, issuer: {} };
  // form fields per behaviour (pack types use their behaviour's fields plus anything the pack requires)
  const FIELDS = {
    source: [['rate_per_min', 'Messages per minute', 'number', true], ['session', 'Session id', 'text'], ['role', 'Role on the diagram', 'text']],
    service: [['capacity_per_min', 'Capacity per minute', 'number', true], ['instances', 'Instances', 'number'], ['rejects', 'Rejected work', ['', 'Held for reprocessing', 'return', 'Returned to sender']], ['role', 'Role on the diagram', 'text'], ['host', 'Server name (shared host)', 'text'], ['mount', 'Data path', 'text']],
    kafka_topic: [['partitions', 'Partitions', 'number', true], ['consumer_group', 'Consumer group', 'text']],
    external_party: [['capacity_per_min', 'Capacity per minute', 'number', true], ['role', 'Role on the diagram', 'text'], ['host', 'Server name', 'text']],
    database: [['pool_size', 'Connection pool size', 'number', true], ['big_table', 'Largest table', 'text'], ['engine', 'Engine', ['', 'Oracle', 'postgres', 'Postgres']], ['host', 'Server name', 'text']],
    ref_data: [['refresh_every_min', 'Loads every (min)', 'number', true], ['stale_after_min', 'Stale after (min)', 'number', true], ['stale_reject_share', 'Share rejected when stale (0–1)', 'number'], ['missing_msg', 'Error when missing ({key} = id)', 'text'], ['key_prefix', 'Id prefix in that error', 'text']],
    issuer: [['symbol', 'Trading symbol', 'text'], ['role', 'Role on the diagram', 'text']],
  };
  const SKIP = ['id', 'type', 'name', 'kind', 'uses', 'feeds', 'count'];

  // ------------------------------------------------------------ state: the raw YAML object being edited
  let B = null, sel = null, undo = [], problems = [], parsed = null;
  const store = { get(k, d) { try { const v = localStorage.getItem('opsdrill.' + k); return v === null ? d : v; } catch (e) { return d; } }, set(k, v) { try { localStorage.setItem('opsdrill.' + k, v); } catch (e) { toast('This browser blocked saving.'); } } };

  function blank() {
    return { id: 'my-system', system: 'My system', description: '', clock: { start: '09:15', cutoff: '10:45', cutoff_label: 'Cut-off' },
      business: { currency: '₹', unit: 'Cr', unit_name: 'orders', avg_notional: 0.05, kpis: [] }, components: [], flow: [], alerts: [], diagram: { groups: [], place: {}, steps: [] } };
  }
  // flow lines "a -> b -> c" become one entry per arrow while editing; written back as lines on save
  function load(raw) {
    B = JSON.parse(JSON.stringify(raw || blank()));
    B.components = B.components || []; B.alerts = B.alerts || []; B.business = B.business || { kpis: [] }; B.business.kpis = B.business.kpis || [];
    B.diagram = B.diagram || {}; B.diagram.place = B.diagram.place || {}; B.diagram.groups = B.diagram.groups || []; B.diagram.steps = B.diagram.steps || [];
    B.clock = B.clock || { start: '09:15', cutoff: '10:45' };
    const edges = [];
    (B.flow || []).forEach(line => { const p = String(line).split('->').map(x => x.trim()).filter(Boolean); for (let i = 0; i < p.length - 1; i++) edges.push([p[i], p[i + 1]]); });
    B._edges = edges; delete B.flow;
    sel = null; undo = [];
    check(); autoPlace(false); render();
  }
  const snapshot = () => { undo.push(JSON.stringify(B)); if (undo.length > 60) undo.shift(); };
  const restore = () => { if (!undo.length) return toast('Nothing to undo.'); B = JSON.parse(undo.pop()); sel = null; check(); render(); };

  // ------------------------------------------------------------ helpers over the model
  const comp = id => B.components.find(c => c && c.id === id);
  const kindOf = c => (c && c.kind && B.kinds && B.kinds[c.kind]) || null;
  const typeOf = c => (c.type || (kindOf(c) || {}).type || 'service');
  const base = c => S.baseType(typeOf(c));
  const label = c => (S.PACK_TYPES[typeOf(c)] ? S.PACK_TYPES[typeOf(c)].label : (BUILTIN.find(b => b.type === typeOf(c)) || {}).label || typeOf(c));
  const posOf = id => toPx(B.diagram.place[id] || [0, 0]);
  function slug(s) { let x = String(s || 'component').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'component'; if (!/^[a-z]/.test(x)) x = 'c_' + x; let y = x, n = 2; while (comp(y)) y = `${x}_${n++}`; return y; }

  // YAML text for the current model (flow written as one line per arrow, chained where it does not branch)
  function toObject() {
    const o = {}; const order = ['id', 'system', 'description', 'clock', 'business', 'kinds', 'components', 'flow', 'alerts', 'diagram', 'tables', 'journeys'];
    const out = Object.fromEntries(Object.entries(B).filter(([k]) => !k.startsWith('_')));
    out.flow = chains(B._edges);
    order.forEach(k => { if (out[k] !== undefined) o[k] = out[k]; });
    Object.keys(out).forEach(k => { if (!(k in o)) o[k] = out[k]; });
    return o;
  }
  function chains(edges) {
    const outs = {}, ins = {}; edges.forEach(([a, b]) => { (outs[a] = outs[a] || []).push(b); (ins[b] = ins[b] || []).push(a); });
    const used = new Set(), lines = [];
    edges.forEach(([a, b]) => {
      if (used.has(a + '>' + b)) return;
      const ch = [a, b]; used.add(a + '>' + b); let cur = b;
      while ((outs[cur] || []).length === 1 && (ins[cur] || []).length === 1) { const nx = outs[cur][0]; if (used.has(cur + '>' + nx) || ch.includes(nx)) break; used.add(cur + '>' + nx); ch.push(nx); cur = nx; }
      lines.push(ch.join(' -> '));
    });
    return lines;
  }
  function toYaml() {
    const o = toObject(), parts = [];
    const head = { ...o }; ['kinds', 'components', 'flow', 'alerts', 'diagram', 'tables', 'journeys'].forEach(k => delete head[k]);
    parts.push(`# ${o.system || 'System'}: designed in the OpsPilot Designer`, yaml.dump(head, { lineWidth: 100 }).trimEnd());
    if (o.kinds) parts.push('', yaml.dump({ kinds: o.kinds }, { flowLevel: 2, lineWidth: 200 }).trimEnd());
    parts.push('', yaml.dump({ components: o.components }, { flowLevel: 2, lineWidth: 240 }).trimEnd());
    parts.push('', yaml.dump({ flow: o.flow }, { lineWidth: 240 }).trimEnd());
    if ((o.alerts || []).length) parts.push('', yaml.dump({ alerts: o.alerts }, { flowLevel: 2, lineWidth: 240 }).trimEnd());
    parts.push('', yaml.dump({ diagram: o.diagram }, { flowLevel: 3, lineWidth: 200 }).trimEnd());
    ['tables', 'journeys'].forEach(k => { if (o[k]) parts.push('', yaml.dump({ [k]: o[k] }, { lineWidth: 160 }).trimEnd()); });
    return parts.join('\n') + '\n';
  }

  // run the simulator's validator; map each problem to the boxes it mentions
  function check() {
    const r = S.validateBlueprint(toObject());
    problems = r.errors || []; parsed = r.blueprint || null;
  }
  const problemsFor = id => problems.filter(p => new RegExp(`(^|[^a-z0-9_])${id}([^a-z0-9_]|$)`).test(p));

  // place components that have no position: flow order left to right, dependencies underneath
  function autoPlace(all) {
    const place = B.diagram.place, ids = B.components.map(c => c.id);
    const ups = {}; ids.forEach(i => { ups[i] = []; });
    B._edges.forEach(([a, b]) => { if (ups[b]) ups[b].push(a); });
    (B.components).forEach(c => { if (B.kinds && c.kind && B.kinds[c.kind]) [].concat(B.kinds[c.kind].connects_to || []).forEach(t => { if (ups[t]) ups[t].push(c.id); }); });
    const layer = {}, seen = new Set();
    const L = id => { if (layer[id] !== undefined) return layer[id]; if (seen.has(id)) return 0; seen.add(id); layer[id] = Math.max(-1, ...ups[id].map(L)) + 1; return layer[id]; };
    ids.forEach(L);
    const rows = {};
    B.components.forEach(c => {
      if (!all && place[c.id]) return;
      const b = base(c), col = ['database', 'ref_data'].includes(b) ? Math.max(1, ...B.components.filter(x => (x.uses || []).includes(c.id)).map(x => layer[x.id])) : b === 'issuer' ? 1 : layer[c.id];
      const r0 = ['database', 'ref_data', 'issuer'].includes(b) ? 3.5 : 0;
      let row = rows[col] !== undefined ? rows[col] : r0;
      const taken = Object.entries(place).filter(([id, [x]]) => id !== c.id && Math.abs(x - col) < 0.5).map(([, [, y]]) => y);
      while (taken.some(y => Math.abs(y - row) < 0.9)) row += 1;
      place[c.id] = [col, row]; rows[col] = row + 1;
    });
  }

  // ------------------------------------------------------------ rendering
  function render() { renderPalette(); renderCanvas(); renderProps(); $('#undoBtn').disabled = !undo.length; if (!$('#yamlBox').hidden) $('#yamlOut').textContent = toYaml(); }

  function renderPalette() {
    const tiles = [...BUILTIN.map(b => ({ ...b, key: 'type:' + b.type, color: COLOR[b.type] }))];
    Object.entries(S.PACK_TYPES).forEach(([t, P]) => tiles.push({ key: 'type:' + t, type: t, label: P.label || t, sub: (P.help || '').split('.')[0], group: `${P.packLabel} pack`, color: COLOR[P.behaves_like] }));
    Object.entries(B.kinds || {}).forEach(([k, d]) => tiles.push({ key: 'kind:' + k, label: d.role || k, sub: `Kind "${k}"${d.connects_to ? ' · connects to ' + [].concat(d.connects_to).join(', ') : ''}`, group: 'Kinds in this system', color: COLOR[S.baseType(d.type)] }));
    const groups = [...new Set(tiles.map(t => t.group))];
    $('#palette').innerHTML = groups.map(g => `<h3>${esc(g)}</h3>` + tiles.filter(t => t.group === g).map(t => `<button class="tile" draggable="true" data-add="${esc(t.key)}" style="--tc:${t.color || 'var(--line)'}"><b>${esc(t.label)}</b><small>${esc(t.sub || '')}</small></button>`).join('')).join('');
  }

  function edgeList() { // flow arrows (yours and kind-made), uses and feeds links
    const out = B._edges.map(([a, b], i) => ({ a, b, k: 'flow', i }));
    B.components.forEach(c => {
      const kd = kindOf(c);
      if (kd) [].concat(kd.connects_to || []).forEach(t => out.push({ a: c.id, b: t, k: 'kind' }));
      if (kd) [].concat(kd.connects_from || []).forEach(f => out.push({ a: f, b: c.id, k: 'kind' }));
      (c.uses || []).forEach(u => out.push({ a: c.id, b: u, k: 'dep' }));
      if (c.feeds) out.push({ a: c.id, b: c.feeds, k: 'feed' });
    });
    return out.filter(e => comp(e.a) && comp(e.b));
  }
  function curve(a, b, vertical) {
    let p0, p3;
    if (!vertical && b.x > a.x + BW * 0.6) { p0 = [a.x + BW, a.y + BH / 2]; p3 = [b.x - 3, b.y + BH / 2]; const dx = Math.max(30, (p3[0] - p0[0]) / 2); return `M${p0} C${p0[0] + dx},${p0[1]} ${p3[0] - dx},${p3[1]} ${p3}`; }
    if (b.y > a.y) { p0 = [a.x + BW / 2, a.y + BH]; p3 = [b.x + BW / 2, b.y - 3]; } else { p0 = [a.x + BW / 2, a.y]; p3 = [b.x + BW / 2, b.y + BH + 3]; }
    const dy = (p3[1] - p0[1]) / 2; return `M${p0} C${p0[0]},${p0[1] + dy} ${p3[0]},${p3[1] - dy} ${p3}`;
  }
  function renderCanvas() {
    const ps = B.components.map(c => posOf(c.id));
    const W = Math.max(900, ...ps.map(p => p.x + BW + 240)), H = Math.max(560, ...ps.map(p => p.y + BH + 200));
    const svg = $('#cv'); svg.setAttribute('width', W); svg.setAttribute('height', H); svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    let g = `<defs><pattern id="gp" width="${COL / 4}" height="${ROW / 4}" patternUnits="userSpaceOnUse"><path class="grid" d="M ${COL / 4} 0 L 0 0 0 ${ROW / 4}" fill="none"/></pattern>
      <marker id="ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path class="arrow" d="M1 1 9 5 1 9"/></marker></defs>
      <rect width="${W}" height="${H}" fill="url(#gp)" data-bg="1"/>`;
    // groups (as the simulator will draw them, including role-based and kind-based ones)
    const grp = parsed ? parsed.diagram.groups : B.diagram.groups;
    (grp || []).forEach(gr => {
      const pts = (gr.ids || []).filter(comp).map(posOf); if (!pts.length) return;
      const x0 = Math.min(...pts.map(p => p.x)) - 12, y0 = Math.min(...pts.map(p => p.y)) - 26, x1 = Math.max(...pts.map(p => p.x)) + BW + 12, y1 = Math.max(...pts.map(p => p.y)) + BH + 12;
      g += `<rect class="grp" x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}" rx="10"/><text class="grp-l" x="${x0 + 10}" y="${y0 + 16}">${esc(gr.label)}</text>`;
    });
    edgeList().forEach(e => {
      const d = curve(posOf(e.a), posOf(e.b), e.k === 'dep' || e.k === 'feed');
      const isSel = sel && sel.edge && sel.edge.a === e.a && sel.edge.b === e.b && sel.edge.k === e.k;
      g += `<path class="edge ${e.k}${isSel ? ' sel' : ''}" d="${d}" ${e.k === 'flow' || e.k === 'kind' ? 'marker-end="url(#ar)"' : ''}/>`;
      g += `<path class="edge-hit" d="${d}" data-edge="${esc(JSON.stringify(e))}"><title>${esc(e.k === 'kind' ? `${e.a} → ${e.b} (made by its kind; change the kind to change it)` : e.k === 'dep' ? `${e.a} reads from ${e.b}` : e.k === 'feed' ? `${e.a} publishes to ${e.b}` : `${e.a} → ${e.b}`)}</title></path>`;
    });
    B.components.forEach(c => {
      const p = posOf(c.id), b = base(c), err = problemsFor(c.id).length, isSel = sel && sel.node === c.id;
      g += `<g class="node${isSel ? ' sel' : ''}${err ? ' err' : ''}" data-node="${esc(c.id)}" style="--tc:${COLOR[b] || '#888'}" tabindex="0" role="button" aria-label="${esc(c.name || c.id)}">
        <rect class="box" x="${p.x}" y="${p.y}" width="${BW}" height="${BH}" rx="7"/><rect class="bar" x="${p.x}" y="${p.y}" width="5" height="${BH}" rx="2"/>
        <text x="${p.x + 14}" y="${p.y + 22}">${esc(String(c.name || c.id).slice(0, 21))}</text>
        <text class="k" x="${p.x + 14}" y="${p.y + 40}">${esc(c.role || label(c))}</text>
        <text class="k" x="${p.x + 14}" y="${p.y + 57}">${esc(c.id)}${c.kind ? ' · kind ' + esc(c.kind) : ''}</text>
        ${err ? `<circle class="errdot" cx="${p.x + BW - 10}" cy="${p.y + 10}" r="5"><title>${esc(problemsFor(c.id).join('\n'))}</title></circle>` : ''}
        ${b !== 'database' && b !== 'ref_data' ? `<circle class="handle" data-handle="${esc(c.id)}" cx="${p.x + BW}" cy="${p.y + BH / 2}" r="7"><title>Drag to another box to connect</title></circle>` : ''}
        ${b === 'issuer' ? '' : ''}</g>`;
    });
    svg.innerHTML = g;
  }

  function field(c, [k, lbl, kind, req]) {
    const v = c[k] === undefined ? '' : c[k], id = 'f_' + k;
    let input;
    if (Array.isArray(kind)) { const opts = []; for (let i = 0; i < kind.length; i += 2) opts.push([kind[i], kind[i + 1]]); input = `<select id="${id}" data-f="${k}">${opts.map(([val, l]) => `<option value="${esc(val)}"${String(v) === val ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`; }
    else input = `<input id="${id}" type="${kind}" data-f="${k}" value="${esc(v)}" ${kind === 'number' ? 'step="any" min="0"' : ''} autocomplete="off">`;
    return `<label class="field" for="${id}"><span>${esc(lbl)}${req ? ' *' : ''}</span>${input}</label>`;
  }
  function renderProps() {
    const P = $('#props');
    if (sel && sel.node && comp(sel.node)) {
      const c = comp(sel.node), b = base(c), PT = S.PACK_TYPES[typeOf(c)], kd = kindOf(c);
      const fields = [...(FIELDS[b] || []), ...((PT && PT.required) || []).filter(k => !(FIELDS[b] || []).some(f => f[0] === k)).map(k => [k, k, 'text', true])];
      const extra = Object.keys(c).filter(k => !SKIP.includes(k) && !fields.some(f => f[0] === k));
      const ownGroups = B.diagram.groups.filter(g => Array.isArray(g.ids) && !g.roles);
      P.innerHTML = `<div class="row between"><h2 style="font-size:19px">${esc(c.name || c.id)}</h2><button class="btn sm danger" id="delNode">Delete</button></div>
        <span class="small muted">${esc(label(c))}${PT ? ` · ${esc(PT.packLabel)} pack` : ''}${kd ? ` · kind <b>${esc(c.kind)}</b> (defaults come from the kind)` : ''}</span>
        <div class="fgrid2"><label class="field wide"><span>Name *</span><input type="text" data-f="name" value="${esc(c.name || '')}" autocomplete="off"></label>
          <label class="field wide"><span>Id * (used in use cases)</span><input type="text" data-id="1" value="${esc(c.id)}" class="mono" autocomplete="off"></label>
          ${fields.map(f => `<div>${field(c, f)}</div>`).join('')}</div>
        ${(c.uses || []).length ? `<div class="stack" style="gap:4px"><span class="label">Reads from</span><div class="chiplist">${c.uses.map(u => `<span class="chipx">${esc(u)}<button data-unuse="${esc(u)}" aria-label="Remove">×</button></span>`).join('')}</div></div>` : ''}
        ${extra.length ? `<p class="small muted" style="margin:0">Also set (kept as written): ${extra.map(k => `<code>${esc(k)}</code>`).join(' ')}</p>` : ''}
        ${ownGroups.length ? `<div class="stack" style="gap:4px"><span class="label">Diagram groups</span>${ownGroups.map((g, i) => `<label class="small row" style="gap:6px"><input type="checkbox" data-grp="${i}" ${g.ids.includes(c.id) ? 'checked' : ''}> ${esc(g.label)}</label>`).join('')}</div>` : ''}
        ${problemsFor(c.id).length ? `<ul class="problems" style="margin:0;padding-left:18px">${problemsFor(c.id).map(p => `<li>${esc(p)}</li>`).join('')}</ul>` : '<span class="okmsg">No problems with this component.</span>'}`;
      return;
    }
    if (sel && sel.edge) {
      const e = sel.edge;
      P.innerHTML = `<h2 style="font-size:19px">Connection</h2><p style="margin:0">${esc(e.a)} ${e.k === 'dep' ? 'reads from' : e.k === 'feed' ? 'publishes to' : '→'} ${esc(e.b)}</p>
        ${e.k === 'kind' ? '<p class="small muted" style="margin:0">Made by the component\'s kind (connects_to). Change or remove it on the kind, or remove the kind from the component.</p>' : '<button class="btn danger" id="delEdge">Delete connection</button>'}`;
      return;
    }
    // nothing selected: the system itself
    const m = B, k = B.business || {};
    P.innerHTML = `<h2 style="font-size:19px">System</h2>
      <div class="fgrid2">
        <label class="field wide"><span>Name *</span><input type="text" data-m="system" value="${esc(m.system || '')}"></label>
        <label class="field"><span>Id *</span><input type="text" data-m="id" class="mono" value="${esc(m.id || '')}"></label>
        <label class="field"><span>Deadline label</span><input type="text" data-c="cutoff_label" value="${esc((m.clock || {}).cutoff_label || '')}"></label>
        <label class="field"><span>Start</span><input type="time" data-c="start" value="${esc((m.clock || {}).start || '09:15')}"></label>
        <label class="field"><span>Deadline</span><input type="time" data-c="cutoff" value="${esc((m.clock || {}).cutoff || '10:45')}"></label>
        <label class="field"><span>Work is counted as</span><input type="text" data-b="unit_name" value="${esc(k.unit_name || 'orders')}"></label>
        <label class="field"><span>Average value (${esc(k.currency || '₹')} ${esc(k.unit || 'Cr')})</span><input type="number" step="any" data-b="avg_notional" value="${esc(k.avg_notional ?? '')}"></label>
      </div>
      <div class="stack" style="gap:6px"><span class="label">Business KPIs (work not yet past a component)</span>
        <div class="tl">${(k.kpis || []).map((x, i) => `<div class="li"><span>${esc(x.label)} <span class="muted">at ${esc(x.at)}${x.cutoff ? ' · deadline' : ''}</span></span><button class="btn sm" data-delkpi="${i}">Remove</button></div>`).join('') || '<span class="small muted">None yet.</span>'}</div>
        <div class="row"><input type="text" id="kLabel" placeholder="e.g. Trades not with clearing" style="flex:1 1 140px"><select id="kAt">${B.components.map(c => `<option value="${esc(c.id)}">${esc(c.name || c.id)}</option>`).join('')}</select><label class="small row" style="gap:4px"><input type="checkbox" id="kCut"> deadline</label><button class="btn sm" id="addKpi">Add</button></div></div>
      <div class="stack" style="gap:6px"><span class="label">Alert rules</span>
        <div class="tl">${(m.alerts || []).map((a, i) => `<div class="li"><span>${esc(a.name)} <span class="muted">${esc(a.on)}.${esc(a.metric)} ${a.below !== undefined ? '< ' + a.below : '> ' + a.above} · ${esc(a.severity || 'P3')}</span></span><button class="btn sm" data-delalert="${i}">Remove</button></div>`).join('') || '<span class="small muted">None yet.</span>'}</div>
        <div class="fgrid2"><input type="text" id="aName" placeholder="Alert name" class="wide"><select id="aOn">${B.components.map(c => `<option value="${esc(c.id)}">${esc(c.name || c.id)}</option>`).join('')}</select><select id="aMetric"></select>
          <select id="aDir"><option value="above">above</option><option value="below">below</option></select><input type="number" id="aVal" step="any" placeholder="threshold">
          <select id="aSev"><option>P1</option><option>P2</option><option selected>P3</option><option>P4</option></select><button class="btn sm" id="addAlert">Add alert</button></div></div>
      <div class="stack" style="gap:6px"><span class="label">Diagram groups</span>
        <div class="tl">${B.diagram.groups.map((g2, i) => `<div class="li"><span>${esc(g2.label)} <span class="muted">${g2.roles ? 'roles: ' + esc(g2.roles.join(', ')) : (g2.ids || []).length + ' components'}</span></span><button class="btn sm" data-delgrp="${i}">Remove</button></div>`).join('') || '<span class="small muted">None yet.</span>'}</div>
        <div class="row"><input type="text" id="gLabel" placeholder="Group name" style="flex:1"><button class="btn sm" id="addGrp">Add group</button></div>
        <span class="small muted">Tick a group in a component's properties to put it in the box.</span></div>
      <div class="stack" style="gap:6px"><span class="label">Check</span>${problems.length ? `<ul class="problems" style="margin:0;padding-left:18px">${problems.map(p => `<li>${esc(p)}</li>`).join('')}</ul>` : `<span class="okmsg">Valid: ${B.components.length} components, ${parsed ? parsed.edges.length : 0} connections. Press Save to simulator.</span>`}</div>`;
    fillMetrics();
  }
  function fillMetrics() {
    const on = $('#aOn'), m = $('#aMetric'); if (!on || !m) return;
    const c = comp(on.value); if (!c) { m.innerHTML = ''; return; }
    m.innerHTML = Object.entries(S.TYPES[base(c)].metrics).map(([k, l]) => `<option value="${k}">${esc(k)}: ${esc(l)}</option>`).join('');
  }

  // ------------------------------------------------------------ edits
  function change(fn) { snapshot(); fn(); check(); render(); }
  function addComponent(key, at) {
    const [what, name] = key.split(':');
    change(() => {
      let c;
      if (what === 'kind') { const d = B.kinds[name]; const id = slug(name); c = { id, kind: name, name: `New ${(d.role || name).toLowerCase()}` }; if (S.baseType(d.type) === 'source' && !d.session) c.session = id.toUpperCase().replace(/_/g, '').slice(0, 6) + '01'; }
      else { const P = S.PACK_TYPES[name], b = S.baseType(name); c = { id: slug((P ? P.label : (BUILTIN.find(x => x.type === name) || {}).label) || name), type: name, name: `New ${((P ? P.label : (BUILTIN.find(x => x.type === name) || {}).label) || name).toLowerCase()}`, ...(DEFAULTS[b] || {}) }; }
      if (what !== 'kind' && S.baseType(typeOf(c)) === 'source' && !c.session) c.session = c.id.toUpperCase().replace(/_/g, '').slice(0, 6) + '01'; // a kind can template its own session names
      B.components.push(c);
      if (!at && sel && sel.node && B.diagram.place[sel.node]) { // build left to right: next to the selected box
        const [c0, r0] = B.diagram.place[sel.node], deps = ['database', 'ref_data'].includes(S.baseType(typeOf(c)));
        let spot = deps ? [c0, r0 + 1.3] : [c0 + 1, r0];
        while (Object.values(B.diagram.place).some(([x, y]) => Math.abs(x - spot[0]) < 0.8 && Math.abs(y - spot[1]) < 0.9)) spot = [spot[0], spot[1] + 1];
        at = spot;
      }
      if (at) B.diagram.place[c.id] = at; else autoPlace(false);
      sel = { node: c.id };
    });
  }
  function connect(a, b) {
    if (a === b) return;
    const A = comp(a), Z = comp(b); if (!A || !Z) return;
    const ba = base(A), bz = base(Z);
    if (ba === 'service' && (bz === 'database' || bz === 'ref_data')) return change(() => { A.uses = [...new Set([...(A.uses || []), b])]; });
    if (ba === 'issuer' && bz === 'ref_data') return change(() => { A.feeds = b; });
    if (FLOW.includes(ba) && FLOW.includes(bz)) {
      if (bz === 'source') return toast(`${Z.name} is a participant: participants only send, nothing flows into them.`);
      if (B._edges.some(([x, y]) => x === a && y === b)) return toast('Already connected.');
      return change(() => { B._edges.push([a, b]); });
    }
    if (bz === 'database' || bz === 'ref_data') return toast(`Only a service can read from ${bz === 'database' ? 'a database' : 'reference data'}.`);
    if (ba === 'issuer') return toast('An issuer can only publish to reference data.');
    toast(`${Z.name} cannot be in the flow; connect it with "uses" from a service instead.`);
  }
  function renameId(from, to) {
    if (!/^[a-z][a-z0-9_]*$/.test(to)) return toast('Ids are lowercase letters, digits and _, starting with a letter.');
    if (comp(to)) return toast(`"${to}" is already used.`);
    change(() => {
      comp(from).id = to;
      B._edges.forEach(e => { if (e[0] === from) e[0] = to; if (e[1] === from) e[1] = to; });
      B.components.forEach(c => { if (Array.isArray(c.uses)) c.uses = c.uses.map(u => u === from ? to : u); if (c.feeds === from) c.feeds = to; if (c.assign && c.assign[from]) { c.assign[to] = c.assign[from]; delete c.assign[from]; } });
      if (B.diagram.place[from]) { B.diagram.place[to] = B.diagram.place[from]; delete B.diagram.place[from]; }
      B.diagram.groups.forEach(g => { if (g.ids) g.ids = g.ids.map(x => x === from ? to : x); });
      B.diagram.steps.forEach(s => { if (s.from === from) s.from = to; if (s.to === from) s.to = to; });
      B.alerts.forEach(a => { if (a.on === from) a.on = to; });
      B.business.kpis.forEach(k => { if (k.at === from) k.at = to; });
      (B.journeys || []).forEach(j => (j.steps || []).forEach(s => { if (s.at === from) s.at = to; if (s.from === from) s.from = to; }));
      Object.values(B.tables || {}).forEach(t => { if (t.db === from) t.db = to; });
      Object.values(B.kinds || {}).forEach(k => { ['connects_to', 'connects_from'].forEach(x => { if (k[x] === from) k[x] = to; else if (Array.isArray(k[x])) k[x] = k[x].map(y => y === from ? to : y); }); });
      sel = { node: to };
    });
  }
  function deleteNode(id) {
    change(() => {
      B.components = B.components.filter(c => c.id !== id);
      B._edges = B._edges.filter(([a, b]) => a !== id && b !== id);
      B.components.forEach(c => { if (Array.isArray(c.uses)) c.uses = c.uses.filter(u => u !== id); if (c.feeds === id) delete c.feeds; });
      delete B.diagram.place[id];
      B.diagram.groups.forEach(g => { if (g.ids) g.ids = g.ids.filter(x => x !== id); });
      B.diagram.steps = B.diagram.steps.filter(s => s.from !== id && s.to !== id);
      B.alerts = B.alerts.filter(a => a.on !== id);
      B.business.kpis = B.business.kpis.filter(k => k.at !== id);
      sel = null;
    });
    toast('Deleted. Use cases and journeys that named it will show as problems until updated.');
  }
  function deleteEdge(e) {
    if (e.k === 'kind') return toast('This connection comes from the kind; change the kind instead.');
    change(() => {
      if (e.k === 'flow') B._edges = B._edges.filter(([a, b]) => !(a === e.a && b === e.b));
      if (e.k === 'dep') comp(e.a).uses = (comp(e.a).uses || []).filter(u => u !== e.b);
      if (e.k === 'feed') delete comp(e.a).feeds;
      sel = null;
    });
  }

  // ------------------------------------------------------------ canvas interaction (pointer events: mouse, pen and touch)
  const wrap = $('#wrap'), svg = $('#cv');
  const svgPoint = ev => { const r = svg.getBoundingClientRect(); return { x: ev.clientX - r.left, y: ev.clientY - r.top }; };
  let drag = null;
  svg.addEventListener('pointerdown', ev => {
    const h = ev.target.closest('[data-handle]'), n = ev.target.closest('[data-node]'), e = ev.target.closest('[data-edge]');
    wrap.focus({ preventScroll: true });
    if (h) { ev.preventDefault(); drag = { link: h.dataset.handle, start: svgPoint(ev) }; svg.setPointerCapture(ev.pointerId); return; }
    if (n) { const id = n.dataset.node, p = svgPoint(ev), q = posOf(id); drag = { move: id, dx: p.x - q.x, dy: p.y - q.y, moved: false, before: JSON.stringify(B) }; svg.setPointerCapture(ev.pointerId); sel = { node: id }; renderProps(); renderCanvas(); return; }
    if (e) { sel = { edge: JSON.parse(e.dataset.edge) }; render(); return; }
    sel = null; render();
  });
  svg.addEventListener('pointermove', ev => {
    if (!drag) return;
    const p = svgPoint(ev);
    if (drag.move) {
      drag.moved = true; B.diagram.place[drag.move] = toCell(p.x - drag.dx, p.y - drag.dy); renderCanvas();
    } else if (drag.link) {
      const a = posOf(drag.link); let t = svg.querySelector('.tmp');
      if (!t) { t = document.createElementNS('http://www.w3.org/2000/svg', 'path'); t.setAttribute('class', 'tmp'); svg.appendChild(t); }
      t.setAttribute('d', `M${a.x + BW},${a.y + BH / 2} L${p.x},${p.y}`);
    }
  });
  svg.addEventListener('pointerup', ev => {
    if (!drag) return;
    const d = drag; drag = null;
    if (d.move) { if (d.moved) { undo.push(d.before); check(); render(); } return; }
    if (d.link) {
      const t = svg.querySelector('.tmp'); if (t) t.remove();
      const under = document.elementsFromPoint(ev.clientX, ev.clientY).map(x => x.closest && x.closest('[data-node]')).find(Boolean);
      if (under && under.dataset.node !== d.link) connect(d.link, under.dataset.node);
    }
  });
  wrap.addEventListener('keydown', ev => {
    if ((ev.key === 'Delete' || ev.key === 'Backspace') && sel && !/input|textarea|select/i.test(document.activeElement.tagName)) { ev.preventDefault(); if (sel.node) deleteNode(sel.node); else if (sel.edge) deleteEdge(sel.edge); }
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'z') { ev.preventDefault(); restore(); }
    if (sel && sel.node && ev.key.startsWith('Arrow')) { // move with the keyboard too
      ev.preventDefault(); const [c, r] = B.diagram.place[sel.node] || [0, 0], s = ev.shiftKey ? 1 : 0.1;
      change(() => { B.diagram.place[sel.node] = [Math.max(0, +(c + (ev.key === 'ArrowRight' ? s : ev.key === 'ArrowLeft' ? -s : 0)).toFixed(2)), Math.max(0, +(r + (ev.key === 'ArrowDown' ? s : ev.key === 'ArrowUp' ? -s : 0)).toFixed(2))]; });
    }
  });
  // palette: drag onto the canvas, or click to add
  $('#palette').addEventListener('dragstart', ev => { const t = ev.target.closest('[data-add]'); if (t) ev.dataTransfer.setData('text/plain', t.dataset.add); });
  $('#palette').addEventListener('click', ev => { const t = ev.target.closest('[data-add]'); if (t) addComponent(t.dataset.add); });
  wrap.addEventListener('dragover', ev => { ev.preventDefault(); wrap.classList.add('drop'); });
  wrap.addEventListener('dragleave', () => wrap.classList.remove('drop'));
  wrap.addEventListener('drop', ev => { ev.preventDefault(); wrap.classList.remove('drop'); const k = ev.dataTransfer.getData('text/plain'); if (!k) return; const p = svgPoint(ev); addComponent(k, toCell(p.x - BW / 2, p.y - BH / 2)); });

  // properties panel
  $('#props').addEventListener('change', ev => {
    const t = ev.target;
    if (t.dataset.id) { const c = comp(sel.node); if (t.value !== c.id) renameId(c.id, t.value.trim()); return; }
    if (t.dataset.f) {
      const c = comp(sel.node), k = t.dataset.f;
      change(() => { if (t.value === '') delete c[k]; else c[k] = t.type === 'number' ? Number(t.value) : t.value; });
      return;
    }
    if (t.dataset.grp !== undefined) { const g = B.diagram.groups.filter(x => Array.isArray(x.ids) && !x.roles)[+t.dataset.grp]; change(() => { g.ids = t.checked ? [...new Set([...g.ids, sel.node])] : g.ids.filter(x => x !== sel.node); }); return; }
    if (t.dataset.m) { change(() => { B[t.dataset.m] = t.value; }); return; }
    if (t.dataset.c) { change(() => { B.clock[t.dataset.c] = t.value; }); return; }
    if (t.dataset.b) { change(() => { B.business[t.dataset.b] = t.type === 'number' ? Number(t.value) : t.value; }); return; }
    if (t.id === 'aOn') fillMetrics();
  });
  $('#props').addEventListener('click', ev => {
    const t = ev.target;
    if (t.id === 'delNode') deleteNode(sel.node);
    else if (t.id === 'delEdge') deleteEdge(sel.edge);
    else if (t.dataset.unuse) { const c = comp(sel.node); change(() => { c.uses = c.uses.filter(u => u !== t.dataset.unuse); if (!c.uses.length) delete c.uses; }); }
    else if (t.dataset.delkpi !== undefined) change(() => { B.business.kpis.splice(+t.dataset.delkpi, 1); });
    else if (t.dataset.delalert !== undefined) change(() => { B.alerts.splice(+t.dataset.delalert, 1); });
    else if (t.dataset.delgrp !== undefined) change(() => { B.diagram.groups.splice(+t.dataset.delgrp, 1); });
    else if (t.id === 'addKpi') { const l = $('#kLabel').value.trim(); if (!l) return toast('Give the KPI a label.'); change(() => { if ($('#kCut').checked) B.business.kpis.forEach(k => delete k.cutoff); B.business.kpis.push({ label: l, at: $('#kAt').value, ...($('#kCut').checked ? { cutoff: true } : {}) }); }); }
    else if (t.id === 'addAlert') { const n = $('#aName').value.trim(), v = $('#aVal').value; if (!n || v === '') return toast('An alert needs a name and a threshold.'); change(() => { B.alerts.push({ name: n, on: $('#aOn').value, metric: $('#aMetric').value, [$('#aDir').value]: Number(v), severity: $('#aSev').value }); }); }
    else if (t.id === 'addGrp') { const l = $('#gLabel').value.trim(); if (!l) return; change(() => { B.diagram.groups.push({ label: l, ids: [] }); }); }
  });

  // ------------------------------------------------------------ top bar
  const sources = [['blank', 'Blank canvas'], ...Object.values(C.blueprints).map(t => { try { const o = yaml.load(t); return [o.id, o.system]; } catch (e) { return null; } }).filter(Boolean), ['__paste', 'Paste YAML…']];
  $('#startFrom').innerHTML = sources.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('');
  $('#startFrom').addEventListener('change', e => {
    const v = e.target.value;
    if (v === '__paste') { $('#pasteBox').hidden = false; $('#pasteText').focus(); return; }
    if (v === 'blank') return load(blank());
    const t = Object.values(C.blueprints).find(x => { try { return yaml.load(x).id === v; } catch (er) { return false; } });
    load(yaml.load(t));
  });
  $('#pasteLoad').addEventListener('click', () => {
    let o; try { o = yaml.load($('#pasteText').value); } catch (e) { $('#pasteMsg').textContent = 'YAML syntax: ' + (e.reason || e.message); return; }
    if (!o || typeof o !== 'object') { $('#pasteMsg').textContent = 'That is not a system.'; return; }
    load(o); $('#pasteBox').hidden = true; toast('Loaded onto the canvas.');
  });
  $('#pasteCancel').addEventListener('click', () => { $('#pasteBox').hidden = true; });
  $('#undoBtn').addEventListener('click', restore);
  $('#tidyBtn').addEventListener('click', () => change(() => { autoPlace(true); }));
  $('#yamlBtn').addEventListener('click', () => { $('#yamlBox').hidden = !$('#yamlBox').hidden; render(); if (!$('#yamlBox').hidden) $('#yamlBox').scrollIntoView({ behavior: 'smooth' }); });
  $('#yamlClose').addEventListener('click', () => { $('#yamlBox').hidden = true; });
  $('#copyBtn').addEventListener('click', () => { const t = toYaml(); if (navigator.clipboard) navigator.clipboard.writeText(t).then(() => toast('YAML copied.'), () => toast('Copy blocked: select the text instead.')); });
  $('#saveBtn').addEventListener('click', () => {
    check();
    if (problems.length) { sel = null; render(); return toast(`Fix ${problems.length} problem${problems.length > 1 ? 's' : ''} first (listed on the right).`); }
    const text = toYaml();
    let saved = []; try { saved = JSON.parse(store.get('systems', '[]')); } catch (e) { saved = []; }
    saved = saved.filter(t => { try { return yaml.load(t).id !== B.id; } catch (e) { return true; } });
    saved.push(text); store.set('systems', JSON.stringify(saved));
    toast(`Saved “${B.system}”. Open the instructor page (admin.html) to run it.`);
  });
  let tt; function toast(t) { const el = $('#toast'); el.textContent = t; el.hidden = false; clearTimeout(tt); tt = setTimeout(() => { el.hidden = true; }, 3600); }

  const first = yaml.load(C.blueprints[C.default_blueprint] || Object.values(C.blueprints)[0]);
  load(first); $('#startFrom').value = first.id;
  window.__designer = { get model() { return B; }, toYaml, check: () => (check(), problems), connect, addComponent, deleteNode, renameId };
})();
