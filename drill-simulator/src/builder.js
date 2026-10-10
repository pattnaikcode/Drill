/* OpsPilot System Builder — build a system blueprint with forms, no YAML typing and no AI.
 * State lives in B. Every edit regenerates the YAML and runs it through the simulator's own
 * validator (engine.js), so what you copy is exactly what the simulator will accept.
 */
(function () {
  'use strict';
  const S = window.OpsSim, yaml = window.jsyaml, C = window.DRILL_CONTENT;
  const $ = s => document.querySelector(s);
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ------------------------------------------------------------ what each component type needs
  const TYPE_HELP = {
    source: { label: 'Participant (sends work in)', ex: 'Broker, market maker, OMS, execution desk', text: 'Where work enters the system. Every flow starts with one. It sends orders or trades at a steady rate.' },
    service: { label: 'Service (processes work)', ex: 'Gateway, risk checks, matching engine, allocation engine', text: 'Takes work from what feeds it, processes up to its capacity, and passes the rest on. Can read from databases and reference data.' },
    kafka_topic: { label: 'Kafka topic (buffers work)', ex: 'trades.executed, trades.matched', text: 'Sits between producers and a consuming service. Decouples them: a slow consumer shows up as lag, not as a slow producer. Several consumers can share a topic with an "assign" map in the YAML.' },
    external_party: { label: 'External party (outside our control)', ex: 'Clearing corporation, CTM, SWIFT, market data vendors', text: 'Receives work from us. When it fails we can only escalate, so restarting our side does not help.' },
    database: { label: 'Database (used by a service)', ex: 'Order book store, allocation DB', text: 'Not in the flow. A service reads it through a connection pool; an exhausted pool slows that service down.' },
    ref_data: { label: 'Reference data (used by a service)', ex: 'Instrument master, SSI data', text: 'Not in the flow. Loaded on a schedule; if it goes stale, services that use it start rejecting work.' },
    issuer: { label: 'Issuer (publishes to reference data)', ex: 'Listed companies', text: 'Not in the flow. Publishes corporate actions into a reference data component; a missed one causes rejects in one symbol.' },
  };
  const FIELDS = {
    source: [
      { k: 'rate_per_min', label: 'Messages per minute', kind: 'number', req: true, help: 'Normal sending rate.' },
      { k: 'role', label: 'Role on the diagram', kind: 'text', help: 'e.g. Broker, Market maker' },
      { k: 'session', label: 'Session id', kind: 'text', help: 'FIX session id; shown in logs and the sessions table.' },
    ],
    service: [
      { k: 'capacity_per_min', label: 'Capacity per minute', kind: 'number', req: true, help: 'Most it can process. Keep it 20–40% above what flows in.' },
      { k: 'instances', label: 'Instances', kind: 'number', help: 'Pods or servers; capacity is shared between them.' },
      { k: 'uses', label: 'Reads from', kind: 'uses', help: 'Databases and reference data this service depends on.' },
      { k: 'rejects', label: 'Rejected work', kind: 'select', opts: [['', 'Held for reprocessing (default)'], ['return', 'Returned to the sender']], help: 'Exchange risk checks return rejects; middle office queues them.' },
      { k: 'role', label: 'Role on the diagram', kind: 'text', help: 'e.g. Exchange, Middle office' },
      { k: 'host', label: 'Server name', kind: 'text', help: 'Optional. Components with the same server name share one host: a full disk or reboot hits all of them.' },
      { k: 'mount', label: 'Data path', kind: 'text', help: 'Optional. Where the host keeps its data, e.g. /data/app; shown by df -h.' },
    ],
    kafka_topic: [
      { k: 'partitions', label: 'Partitions', kind: 'number', req: true, help: 'Work is spread evenly across partitions.' },
      { k: 'consumer_group', label: 'Consumer group', kind: 'text', help: 'Shown in lag commands and logs.' },
    ],
    external_party: [
      { k: 'capacity_per_min', label: 'Capacity per minute', kind: 'number', req: true, help: 'How much it can accept per minute.' },
      { k: 'role', label: 'Role on the diagram', kind: 'text', help: 'e.g. Clearing corporation' },
      { k: 'host', label: 'Server name', kind: 'text', help: 'Optional. Components with the same server name share one host: a full disk or reboot hits all of them.' },
    ],
    database: [
      { k: 'pool_size', label: 'Connection pool size', kind: 'number', req: true, help: 'Connections available to services.' },
      { k: 'big_table', label: 'Largest table', kind: 'text', help: 'Named in the long-running-query fault.' },
      { k: 'engine', label: 'Database engine', kind: 'select', opts: [['', 'Oracle (default)'], ['postgres', 'Postgres']], help: 'Changes error messages, the data path and the SQL session view.' },
      { k: 'host', label: 'Server name', kind: 'text', help: 'Optional. Components with the same server name share one host: a full disk or reboot hits all of them.' },
    ],
    ref_data: [
      { k: 'refresh_every_min', label: 'Loads every (minutes)', kind: 'number', req: true, help: 'How often the feed loads.' },
      { k: 'stale_after_min', label: 'Stale after (minutes)', kind: 'number', req: true, help: 'After this, services that use it reject work.' },
      { k: 'stale_reject_share', label: 'Share rejected when stale', kind: 'number', help: 'Optional, 0 to 1. Default 0.08; use 0.9 when nothing can be processed without it.' },
      { k: 'missing_msg', label: 'Error when data is missing', kind: 'text', help: 'Optional log line; {key} is replaced with an id.' },
    ],
    issuer: [
      { k: 'feeds', label: 'Publishes to', kind: 'feeds', req: true, help: 'The reference data component it updates.' },
      { k: 'symbol', label: 'Trading symbol', kind: 'text', help: 'Shown in reject messages.' },
      { k: 'role', label: 'Role on the diagram', kind: 'text', help: 'Usually Issuer' },
    ],
  };
  const DEFAULTS = { source: { rate_per_min: 300 }, service: { capacity_per_min: 420, instances: 2 }, kafka_topic: { partitions: 6 }, external_party: { capacity_per_min: 500 }, database: { pool_size: 50 }, ref_data: { refresh_every_min: 15, stale_after_min: 30 }, issuer: {} };
  const FLOW_TYPES = ['source', 'service', 'kafka_topic', 'external_party'];
  // packs add new component types; each borrows the form fields of the behaviour it is based on
  const bt = t => S.baseType(t);
  (C.packs || []).forEach(text => { try { S.registerPack(yaml.load(text)); } catch (e) { /* a broken pack is reported in the simulator */ } });
  Object.entries(S.PACK_TYPES).forEach(([t, P]) => {
    TYPE_HELP[t] = { label: `${P.label || t} (${P.packLabel} pack)`, ex: '', text: P.help || `Behaves like ${TYPE_HELP[P.behaves_like].label.split(' (')[0].toLowerCase()}.` };
    FIELDS[t] = [...FIELDS[P.behaves_like], ...((P.required || []).filter(k => !FIELDS[P.behaves_like].some(f => f.k === k)).map(k => ({ k, label: k, kind: 'text', req: true, help: 'Required by this pack.' })))];
    DEFAULTS[t] = { ...DEFAULTS[P.behaves_like] };
    if (FLOW_TYPES.includes(P.behaves_like)) FLOW_TYPES.push(t);
  });

  // ------------------------------------------------------------ state
  let B = blank();
  let newType = 'source'; // remembered choice in the Add component dropdown
  function blank() {
    return {
      meta: { id: 'my-system', system: 'My system', description: '', start: '09:15', cutoff: '10:45', cutoff_label: 'Cut-off', currency: '₹', unit: 'Cr', unit_name: 'orders', avg_notional: 0.05 },
      comps: [], flows: [], kpis: [], alerts: [], groups: [], steps: [], place: {}, notes: '', extra: {},
    };
  }
  function fromBlueprint(raw) { // load an existing blueprint into the forms
    const b = blank();
    const cl = raw.clock || {}, bz = raw.business || {};
    Object.assign(b.meta, { id: raw.id || 'my-system', system: raw.system || '', description: (raw.description || '').trim(), start: cl.start || '09:15', cutoff: cl.cutoff || '10:45', cutoff_label: cl.cutoff_label || 'Cut-off', currency: bz.currency || '₹', unit: bz.unit || 'Cr', unit_name: bz.unit_name || 'orders', avg_notional: bz.avg_notional ?? 0.05 });
    const kinds = raw.kinds || {};
    b.comps = (raw.components || []).map(c => (c && c.kind && !c.type && kinds[c.kind] ? { ...c, type: kinds[c.kind].type, ...(c.role || !kinds[c.kind].role ? {} : { role: kinds[c.kind].role }) } : { ...c }));
    (raw.flow || []).forEach(line => { const p = String(line).split('->').map(s => s.trim()).filter(Boolean); for (let i = 0; i < p.length - 1; i++) b.flows.push([p[i], p[i + 1]]); });
    b.kpis = (bz.kpis || []).map(k => ({ label: k.label, at: k.at, cutoff: !!k.cutoff }));
    b.alerts = (raw.alerts || []).map(a => ({ name: a.name, on: a.on, metric: a.metric, dir: typeof a.below === 'number' ? 'below' : 'above', value: typeof a.below === 'number' ? a.below : a.above, severity: a.severity || 'P3' }));
    const dg = raw.diagram || {};
    b.groups = (dg.groups || []).map(g => ({ label: g.label, ids: [...(g.ids || [])] }));
    b.steps = (dg.steps || []).map(s => ({ ...s }));
    b.place = { ...(dg.place || {}) }; b.notes = (dg.notes || '').trim();
    ['kinds', 'tables', 'journeys'].forEach(k => { if (raw[k]) b.extra[k] = raw[k]; }); // no forms for these yet: kept exactly as written
    return b;
  }

  // ------------------------------------------------------------ YAML writer (readable, one component per line)
  const PLAIN = /^[A-Za-z][A-Za-z0-9 _.()&/'-]*$/;
  const RESERVED = /^(true|false|yes|no|on|off|null|~)$/i;
  function q(v) {
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    v = String(v);
    return PLAIN.test(v) && !RESERVED.test(v) && !/\s$/.test(v) ? v : JSON.stringify(v);
  }
  function inline(obj) {
    return '{' + Object.entries(obj).filter(([, v]) => v !== '' && v !== undefined && v !== null && !(Array.isArray(v) && !v.length))
      .map(([k, v]) => `${k}: ${Array.isArray(v) ? '[' + v.map(q).join(', ') + ']' : v && typeof v === 'object' ? inline(v) : q(v)}`).join(', ') + '}';
  }
  const BASE_KEYS = ['id', 'type', 'name', 'role'];  // "kind" and "count" are kept like other settings
  function extraKeys(c) { return Object.keys(c).filter(k => !BASE_KEYS.includes(k) && !FIELDS[c.type].some(f => f.k === k) && c[k] !== undefined && c[k] !== ''); }
  function chains(edges) { // join a->b, b->c into a -> b -> c where nothing else branches
    const out = {}, inn = {};
    edges.forEach(([a, b]) => { (out[a] = out[a] || []).push(b); (inn[b] = inn[b] || []).push(a); });
    const used = new Set(), lines = [];
    edges.forEach(([a, b]) => {
      if (used.has(a + '>' + b)) return;
      const chain = [a, b]; used.add(a + '>' + b);
      let cur = b;
      while ((out[cur] || []).length === 1 && (inn[cur] || []).length === 1) {
        const nx = out[cur][0]; if (used.has(cur + '>' + nx) || chain.includes(nx)) break;
        used.add(cur + '>' + nx); chain.push(nx); cur = nx;
      }
      lines.push(chain.join(' -> '));
    });
    return lines;
  }
  function toYaml() {
    const m = B.meta, L = [];
    L.push(`# ${m.system || 'System'} — generated with the OpsPilot System Builder`, '');
    L.push(`id: ${q(m.id)}`, `system: ${q(m.system)}`);
    if (m.description) L.push('description: >', ...wrap(m.description, 92).map(x => '  ' + x));
    L.push('', '# Simulated trading window. Use cases inject faults between start and cut-off.', 'clock:', `  start: ${JSON.stringify(m.start)}`, `  cutoff: ${JSON.stringify(m.cutoff)}`, `  cutoff_label: ${q(m.cutoff_label)}`);
    L.push('', '# How business impact is shown: work not yet past a component, counted in money.', 'business:', `  currency: ${JSON.stringify(m.currency)}`, `  unit: ${q(m.unit)}`, `  unit_name: ${q(m.unit_name)}`, `  avg_notional: ${Number(m.avg_notional) || 0}`);
    if (B.kpis.length) { L.push('  kpis:'); B.kpis.forEach(k => L.push('    - ' + inline({ label: k.label, at: k.at, ...(k.cutoff ? { cutoff: true } : {}) }))); }
    L.push('', '# Every component: an id (used everywhere else), a type, a display name and its settings.', 'components:');
    B.comps.forEach(c => {
      const o = { id: c.id, type: c.type, ...(c.role ? { role: c.role } : {}), name: c.name };
      FIELDS[c.type].forEach(f => { if (f.k !== 'role' && c[f.k] !== undefined && c[f.k] !== '' && !(Array.isArray(c[f.k]) && !c[f.k].length)) o[f.k] = c[f.k]; });
      extraKeys(c).forEach(k => { o[k] = c[k]; }); // settings the forms do not show are kept as they were
      L.push('  - ' + inline(o));
    });
    L.push('', '# Business flow: "a -> b" means everything a sends goes to b. A component can appear in several lines.', 'flow:');
    chains(B.flows).forEach(x => L.push('  - ' + x));
    if (B.alerts.length) {
      L.push('', '# Alert rules: fire when a metric stays past its threshold for one simulated minute.', 'alerts:');
      B.alerts.forEach(a => L.push('  - ' + inline({ name: a.name, on: a.on, metric: a.metric, [a.dir]: Number(a.value), severity: a.severity })));
    }
    if (B.groups.length || B.steps.length || B.notes || Object.keys(B.place).length) {
      L.push('', '# Reference flow diagram shown to participants.', 'diagram:');
      if (B.notes) L.push('  notes: >', ...wrap(B.notes, 88).map(x => '    ' + x));
      if (B.groups.length) { L.push('  groups:'); B.groups.forEach(g => L.push('    - ' + inline({ label: g.label, ids: g.ids }))); }
      const pl = Object.entries(B.place).filter(([id]) => B.comps.some(c => c.id === id));
      if (pl.length) { L.push('  place:'); pl.forEach(([id, p]) => L.push(`    ${id}: [${p.join(', ')}]`)); }
      if (B.steps.length) { L.push('  steps:'); B.steps.forEach(s => L.push('    - ' + inline({ from: s.from, to: s.to, text: s.text }))); }
    }
    const extra = Object.entries(B.extra || {}).filter(([, v]) => v && (Array.isArray(v) ? v.length : Object.keys(v).length));
    if (extra.length) {
      L.push('', '# Kinds, and follow-an-order tables and journeys (kept from your YAML).');
      extra.forEach(([k, v]) => L.push(yaml.dump({ [k]: v }, { lineWidth: 110, flowLevel: k === 'tables' ? 2 : 4 }).trimEnd()));
    }
    return L.join('\n') + '\n';
  }
  function wrap(text, w) {
    const words = String(text).replace(/\s+/g, ' ').trim().split(' '), out = [];
    let line = '';
    words.forEach(x => { if ((line + ' ' + x).trim().length > w) { out.push(line); line = x; } else line = (line + ' ' + x).trim(); });
    if (line) out.push(line);
    return out;
  }

  // ------------------------------------------------------------ helpers over state
  const comp = id => B.comps.find(c => c.id === id);
  const ids = filter => B.comps.filter(filter || (() => true)).map(c => c.id);
  const opt = (v, label, sel) => `<option value="${esc(v)}"${sel ? ' selected' : ''}>${esc(label)}</option>`;
  const compOpts = (list, sel, blankLabel) => (blankLabel ? opt('', blankLabel, !sel) : '') + list.map(id => opt(id, `${comp(id).name} (${id})`, id === sel)).join('');
  function slug(name) { let s = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'component'; if (!/^[a-z]/.test(s)) s = 'c_' + s; let x = s, n = 2; while (comp(x)) x = `${s}_${n++}`; return x; }
  function renameRefs(from, to) {
    if (!from || from === to) return;
    B.flows.forEach(e => { if (e[0] === from) e[0] = to; if (e[1] === from) e[1] = to; });
    B.comps.forEach(c => {
      if (Array.isArray(c.uses)) c.uses = c.uses.map(u => u === from ? to : u); if (c.feeds === from) c.feeds = to;
      if (c.assign && c.assign[from]) { c.assign[to] = c.assign[from]; delete c.assign[from]; }
    });
    (B.extra.journeys || []).forEach(j => (j.steps || []).forEach(st => { if (st.at === from) st.at = to; }));
    Object.values(B.extra.tables || {}).forEach(t => { if (t.db === from) t.db = to; });
    B.kpis.forEach(k => { if (k.at === from) k.at = to; });
    B.alerts.forEach(a => { if (a.on === from) a.on = to; });
    B.groups.forEach(g => { g.ids = g.ids.map(i => i === from ? to : i); });
    B.steps.forEach(s => { if (s.from === from) s.from = to; if (s.to === from) s.to = to; });
    if (B.place[from]) { B.place[to] = B.place[from]; delete B.place[from]; }
  }
  function removeComp(id) {
    B.comps = B.comps.filter(c => c.id !== id);
    B.flows = B.flows.filter(([a, b]) => a !== id && b !== id);
    B.comps.forEach(c => { if (Array.isArray(c.uses)) c.uses = c.uses.filter(u => u !== id); if (c.feeds === id) c.feeds = ''; });
    B.kpis = B.kpis.filter(k => k.at !== id); B.alerts = B.alerts.filter(a => a.on !== id);
    B.groups.forEach(g => { g.ids = g.ids.filter(i => i !== id); });
    B.steps = B.steps.filter(s => s.from !== id && s.to !== id); delete B.place[id];
  }
  const linkPairs = () => [...B.flows.map(e => [e[0], e[1]]), ...B.comps.flatMap(c => [...(c.uses || []).map(u => [c.id, u]), ...(bt(c.type) === 'issuer' && c.feeds ? [[c.id, c.feeds]] : [])])];

  // ------------------------------------------------------------ forms
  function field(i, c, f) {
    const v = c[f.k] === undefined ? '' : c[f.k], key = `data-c="${i}" data-k="${f.k}"`, id = `f-${i}-${f.k}`;
    let input;
    if (f.kind === 'number') input = `<input id="${id}" type="number" min="0" step="any" ${key} value="${esc(v)}">`;
    else if (f.kind === 'text') input = `<input id="${id}" type="text" ${key} value="${esc(v)}" autocomplete="off">`;
    else if (f.kind === 'select') input = `<select id="${id}" ${key}>${f.opts.map(([val, l]) => opt(val, l, String(v) === val)).join('')}</select>`;
    else if (f.kind === 'feeds') input = `<select id="${id}" ${key}>${compOpts(ids(x => bt(x.type) === 'ref_data'), v, 'Choose reference data')}</select>`;
    else if (f.kind === 'uses') {
      const cands = ids(x => bt(x.type) === 'database' || bt(x.type) === 'ref_data');
      input = cands.length ? `<div class="checks">${cands.map(u => `<label class="small"><input type="checkbox" data-c="${i}" data-uses="${u}" ${(c.uses || []).includes(u) ? 'checked' : ''}> ${esc(comp(u).name)}</label>`).join('')}</div>` : '<span class="small muted">Add a database or reference data component first.</span>';
    }
    return `<label class="field" for="${id}"><span>${esc(f.label)}${f.req ? ' <b class="req">required</b>' : ''}</span>${input}<span class="fhint">${esc(f.help)}</span></label>`;
  }
  function compCard(c, i) {
    const t = TYPE_HELP[c.type];
    return `<div class="ccard" id="card-${i}">
      <div class="row between"><span class="pill info">${esc(t.label)}</span><button class="btn sm" data-del-comp="${i}" aria-label="Remove ${esc(c.name)}">Remove</button></div>
      <div class="fgrid">
        <label class="field" for="n-${i}"><span>Name <b class="req">required</b></span><input id="n-${i}" type="text" data-c="${i}" data-k="name" value="${esc(c.name)}" autocomplete="off"><span class="fhint">Shown on the map and in logs.</span></label>
        <label class="field" for="id-${i}"><span>Id <b class="req">required</b></span><input id="id-${i}" type="text" data-c="${i}" data-id="1" value="${esc(c.id)}" autocomplete="off" class="mono"><span class="fhint">Lowercase, digits, _. Used to connect things.</span></label>
        ${FIELDS[c.type].map(f => field(i, c, f)).join('')}
      </div>
      ${extraKeys(c).length ? `<p class="fhint" style="margin:0">Kept from your YAML (edit them there): ${extraKeys(c).map(k => `<code>${esc(k)}</code>`).join(' ')}</p>` : ''}</div>`;
  }
  function renderForms() {
    const m = B.meta;
    const flowIds = ids(c => FLOW_TYPES.includes(c.type));
    const metricsOf = id => comp(id) ? Object.entries(S.TYPES[bt(comp(id).type)].metrics) : [];
    $('#forms').innerHTML = `
      <section class="panel stack" id="sec-system"><h2>1. System</h2>
        <div class="fgrid">
          <label class="field" for="m-system"><span>System name <b class="req">required</b></span><input id="m-system" type="text" data-m="system" value="${esc(m.system)}"></label>
          <label class="field" for="m-id"><span>System id</span><input id="m-id" class="mono" type="text" data-m="id" value="${esc(m.id)}"><span class="fhint">Use cases name this in <code>systems:</code>.</span></label>
          <label class="field wide" for="m-desc"><span>Description</span><textarea id="m-desc" rows="2" data-m="description">${esc(m.description)}</textarea></label>
          <label class="field" for="m-start"><span>Window starts</span><input id="m-start" type="time" data-m="start" value="${esc(m.start)}"></label>
          <label class="field" for="m-cut"><span>Deadline (cut-off)</span><input id="m-cut" type="time" data-m="cutoff" value="${esc(m.cutoff)}"></label>
          <label class="field" for="m-cl"><span>Deadline name</span><input id="m-cl" type="text" data-m="cutoff_label" value="${esc(m.cutoff_label)}"><span class="fhint">e.g. Clearing cut-off</span></label>
          <label class="field" for="m-un"><span>Work is counted as</span><input id="m-un" type="text" data-m="unit_name" value="${esc(m.unit_name)}"><span class="fhint">orders, trades, payments</span></label>
          <label class="field" for="m-cur"><span>Currency</span><input id="m-cur" type="text" data-m="currency" value="${esc(m.currency)}"></label>
          <label class="field" for="m-unit"><span>Money unit</span><input id="m-unit" type="text" data-m="unit" value="${esc(m.unit)}"><span class="fhint">Cr, lakh, mn</span></label>
          <label class="field" for="m-avg"><span>Average value per item</span><input id="m-avg" type="number" step="any" data-m="avg_notional" value="${esc(m.avg_notional)}"><span class="fhint">In the money unit; turns counts into money.</span></label>
        </div></section>

      <section class="panel stack" id="sec-comps"><div class="row between"><h2>2. Components</h2><span class="small muted">${B.comps.length} added</span></div>
        <div class="row"><label class="field grow" for="newType"><span>Add a component</span><select id="newType">${Object.entries(TYPE_HELP).map(([k, t]) => opt(k, t.ex ? `${t.label} — e.g. ${t.ex}` : t.label, k === newType)).join('')}</select></label><button class="btn primary" id="addComp">Add component</button></div>
        <p class="small muted" id="typeHelp" style="margin:0">${esc(TYPE_HELP[newType].text)}</p>
        <div class="stack" style="gap:10px">${B.comps.map(compCard).join('') || '<p class="muted small" style="margin:0">No components yet. Start with a participant, then the services it sends to.</p>'}</div></section>

      <section class="panel stack" id="sec-flow"><h2>3. Connections (business flow)</h2>
        <p class="small muted" style="margin:0">Each connection sends everything from one component to the next. Participants only send; Kafka topics need exactly one consuming service; databases, reference data and issuers are linked in their own settings, not here.</p>
        <div class="row"><select id="fFrom" aria-label="From">${compOpts(flowIds.filter(id => comp(id).type !== 'external_party' || true), '', 'From…')}</select><span aria-hidden="true">→</span><select id="fTo" aria-label="To">${compOpts(flowIds.filter(id => comp(id).type !== 'source'), '', 'To…')}</select><button class="btn" id="addFlow">Connect</button></div>
        <div class="list">${B.flows.map(([a, b], i) => `<div class="li"><span class="mono small">${esc(comp(a) ? comp(a).name : a)} → ${esc(comp(b) ? comp(b).name : b)}</span><button class="btn sm" data-del-flow="${i}">Remove</button></div>`).join('') || '<p class="muted small" style="margin:0">No connections yet.</p>'}</div></section>

      <section class="panel stack" id="sec-kpi"><h2>4. Business impact</h2>
        <p class="small muted" style="margin:0">A KPI counts work produced but not yet past a component, e.g. “Trades not with clearing” at the clearing component. Mark one as the deadline KPI: it decides whether the deadline is met.</p>
        <div class="row"><input type="text" id="kLabel" placeholder="Label, e.g. Orders waiting to match" class="grow"><select id="kAt" aria-label="Measured at">${compOpts(flowIds.filter(id => comp(id).type !== 'source'), '', 'Measured at…')}</select><label class="small row" style="gap:4px"><input type="checkbox" id="kCut"> Deadline KPI</label><button class="btn" id="addKpi">Add KPI</button></div>
        <div class="list">${B.kpis.map((k, i) => `<div class="li"><span class="small">${esc(k.label)} <span class="muted">at ${esc(k.at)}</span>${k.cutoff ? ' <span class="pill warn">deadline</span>' : ''}</span><button class="btn sm" data-del-kpi="${i}">Remove</button></div>`).join('') || '<p class="muted small" style="margin:0">No KPIs yet.</p>'}</div></section>

      <section class="panel stack" id="sec-alerts"><h2>5. Alert rules</h2>
        <p class="small muted" style="margin:0">What monitoring pages on. Each rule watches one metric of one component.</p>
        <div class="fgrid">
          <label class="field" for="aName"><span>Alert name</span><input id="aName" type="text" placeholder="e.g. Gateway queue building"></label>
          <label class="field" for="aOn"><span>Component</span><select id="aOn">${compOpts(ids(), '', 'Choose…')}</select></label>
          <label class="field" for="aMetric"><span>Metric</span><select id="aMetric"><option value="">Choose a component first</option></select></label>
          <label class="field" for="aDir"><span>Fires when</span><select id="aDir">${opt('above', 'above')}${opt('below', 'below')}</select></label>
          <label class="field" for="aVal"><span>Threshold</span><input id="aVal" type="number" step="any"></label>
          <label class="field" for="aSev"><span>Severity</span><select id="aSev">${['P1', 'P2', 'P3', 'P4'].map(p => opt(p, p, p === 'P2')).join('')}</select></label>
        </div>
        <div class="row"><button class="btn" id="addAlert">Add alert rule</button></div>
        <div class="list">${B.alerts.map((a, i) => `<div class="li"><span class="small"><span class="pill ${a.severity === 'P1' ? 'bad' : a.severity === 'P2' ? 'warn' : 'mut'}">${esc(a.severity)}</span> ${esc(a.name)} <span class="muted mono">${esc(a.on)}.${esc(a.metric)} ${a.dir === 'above' ? '>' : '<'} ${esc(a.value)}</span></span><button class="btn sm" data-del-alert="${i}">Remove</button></div>`).join('') || '<p class="muted small" style="margin:0">No alert rules yet.</p>'}</div></section>

      <section class="panel stack" id="sec-diagram"><h2>6. Flow diagram</h2>
        <p class="small muted" style="margin:0">Optional, but participants rely on it. Groups draw a labelled box around components (who owns what). Steps put numbered badges on links and list them under the diagram.</p>
        <h3>Groups</h3>
        <div class="row"><input type="text" id="gLabel" placeholder="e.g. Members" class="grow"><button class="btn" id="addGroup">Add group</button></div>
        <div class="stack" style="gap:8px">${B.groups.map((g, gi) => `<div class="ccard"><div class="row between"><input type="text" data-g="${gi}" value="${esc(g.label)}" aria-label="Group label"><button class="btn sm" data-del-group="${gi}">Remove</button></div><div class="checks">${B.comps.map(c => `<label class="small"><input type="checkbox" data-g="${gi}" data-gid="${c.id}" ${g.ids.includes(c.id) ? 'checked' : ''}> ${esc(c.name)}</label>`).join('')}</div></div>`).join('')}</div>
        <h3>Numbered steps</h3>
        <div class="row"><select id="sLink" aria-label="Link">${opt('', 'Choose a link…')}${linkPairs().map(([a, b]) => opt(a + '>' + b, `${comp(a) ? comp(a).name : a} → ${comp(b) ? comp(b).name : b}`)).join('')}</select><input type="text" id="sText" placeholder="What happens on this link, in one sentence" class="grow"><button class="btn" id="addStep">Add step</button></div>
        <ol class="steps">${B.steps.map((s, i) => `<li><span class="small">${esc(s.text)} <span class="muted mono">(${esc(s.from)} → ${esc(s.to)})</span></span> <button class="btn sm" data-del-step="${i}">Remove</button></li>`).join('')}</ol>
        <label class="field" for="dNotes"><span>Notes under the diagram</span><textarea id="dNotes" rows="2" data-notes="1">${esc(B.notes)}</textarea></label>
        ${Object.keys(B.place).length ? `<p class="small muted" style="margin:0">This system has fixed diagram positions for ${Object.keys(B.place).length} components (kept as they are). New components are placed automatically.</p>` : ''}
      </section>`;
    wireForms();
    updateOutput();
  }

  // ------------------------------------------------------------ output
  function updateOutput() {
    const text = toYaml();
    $('#yaml').textContent = text;
    const r = S.parseBlueprint(text, yaml);
    $('#status').innerHTML = r.errors.length
      ? `<p class="bad-t"><b>${r.errors.length} thing${r.errors.length === 1 ? '' : 's'} to fix before the simulator will accept this:</b></p><ul class="errors">${r.errors.map(e => `<li>${esc(e)}</li>`).join('')}</ul>`
      : `<p class="ok-t"><b>Valid.</b> ${r.blueprint.components.length} components, ${r.blueprint.edges.length} connections, ${r.blueprint.alerts.length} alert rules. Copy it into the simulator's Design tab, or save it as <code>blueprints/${esc(B.meta.id)}.yaml</code>.</p>`;
  }

  // ------------------------------------------------------------ events
  function wireForms() {
    const forms = $('#forms');
    forms.oninput = e => {
      const t = e.target;
      if (t.dataset.m) { B.meta[t.dataset.m] = t.type === 'number' ? (t.value === '' ? '' : Number(t.value)) : t.value; return updateOutput(); }
      if (t.dataset.notes) { B.notes = t.value; return updateOutput(); }
      if (t.dataset.g !== undefined && !t.dataset.gid) { B.groups[+t.dataset.g].label = t.value; return updateOutput(); }
      if (t.dataset.c !== undefined && t.dataset.k) {
        const c = B.comps[+t.dataset.c]; const f = t.dataset.k;
        if (t.type === 'number') { if (t.value === '') delete c[f]; else c[f] = Number(t.value); }
        else if (t.value === '') delete c[f]; else c[f] = t.value;
        if (f === 'name') c.name = t.value;
        return updateOutput();
      }
    };
    forms.onchange = e => {
      const t = e.target;
      if (t.dataset.id) { const c = B.comps[+t.dataset.c]; const nv = t.value.trim(); if (nv && nv !== c.id && !comp(nv)) { renameRefs(c.id, nv); c.id = nv; } renderForms(); return; }
      if (t.dataset.uses) { const c = B.comps[+t.dataset.c]; c.uses = c.uses || []; if (t.checked) { if (!c.uses.includes(t.dataset.uses)) c.uses.push(t.dataset.uses); } else c.uses = c.uses.filter(u => u !== t.dataset.uses); if (!c.uses.length) delete c.uses; renderForms(); return; }
      if (t.dataset.gid) { const g = B.groups[+t.dataset.g]; if (t.checked) g.ids.push(t.dataset.gid); else g.ids = g.ids.filter(i => i !== t.dataset.gid); updateOutput(); return; }
      if (t.dataset.k === 'feeds' || t.dataset.k === 'rejects') renderForms();
    };
    forms.onclick = e => {
      const t = e.target.closest('button'); if (!t) return;
      const d = t.dataset;
      if (d.delComp !== undefined) { removeComp(B.comps[+d.delComp].id); renderForms(); }
      else if (d.delFlow !== undefined) { B.flows.splice(+d.delFlow, 1); renderForms(); }
      else if (d.delKpi !== undefined) { B.kpis.splice(+d.delKpi, 1); renderForms(); }
      else if (d.delAlert !== undefined) { B.alerts.splice(+d.delAlert, 1); renderForms(); }
      else if (d.delGroup !== undefined) { B.groups.splice(+d.delGroup, 1); renderForms(); }
      else if (d.delStep !== undefined) { B.steps.splice(+d.delStep, 1); renderForms(); }
    };
    $('#newType').onchange = e => { newType = e.target.value; $('#typeHelp').textContent = TYPE_HELP[newType].text; };
    $('#addComp').onclick = () => {
      const type = newType, name = `New ${TYPE_HELP[type].label.split(' (')[0].toLowerCase()}`;
      const c = { id: slug(name), type, name, ...DEFAULTS[type] };
      if (type === 'issuer') { const r = ids(x => bt(x.type) === 'ref_data')[0]; if (r) c.feeds = r; }
      B.comps.push(c); renderForms();
      const card = $(`#card-${B.comps.length - 1}`); if (card) { card.scrollIntoView({ block: 'center' }); card.querySelector('input').select(); }
    };
    $('#addFlow').onclick = () => {
      const a = $('#fFrom').value, b = $('#fTo').value;
      if (!a || !b) return flash('Choose both ends of the connection.');
      if (a === b) return flash('A component cannot feed itself.');
      if (B.flows.some(e => e[0] === a && e[1] === b)) return flash('That connection already exists.');
      B.flows.push([a, b]); renderForms();
    };
    $('#addKpi').onclick = () => {
      const label = $('#kLabel').value.trim(), at = $('#kAt').value, cut = $('#kCut').checked;
      if (!label || !at) return flash('Give the KPI a label and the component it is measured at.');
      if (cut) B.kpis.forEach(k => { k.cutoff = false; });
      B.kpis.push({ label, at, cutoff: cut }); renderForms();
    };
    $('#aOn').onchange = e => { const c = comp(e.target.value); $('#aMetric').innerHTML = c ? Object.entries(S.TYPES[bt(c.type)].metrics).map(([k, l]) => opt(k, `${k} — ${l}`)).join('') : opt('', 'Choose a component first'); };
    $('#addAlert').onclick = () => {
      const a = { name: $('#aName').value.trim(), on: $('#aOn').value, metric: $('#aMetric').value, dir: $('#aDir').value, value: $('#aVal').value, severity: $('#aSev').value };
      if (!a.name || !a.on || !a.metric || a.value === '') return flash('Fill in the alert name, component, metric and threshold.');
      a.value = Number(a.value); B.alerts.push(a); renderForms();
    };
    $('#addGroup').onclick = () => { const l = $('#gLabel').value.trim(); if (!l) return flash('Give the group a label.'); B.groups.push({ label: l, ids: [] }); renderForms(); };
    $('#addStep').onclick = () => {
      const link = $('#sLink').value, text = $('#sText').value.trim();
      if (!link || !text) return flash('Choose a link and describe what happens on it.');
      const [from, to] = link.split('>'); B.steps.push({ from, to, text }); renderForms();
    };
  }
  function flash(msg) { const el = $('#toast'); el.textContent = msg; el.hidden = false; clearTimeout(flash.t); flash.t = setTimeout(() => { el.hidden = true; }, 2800); }

  // top controls
  const presets = Object.entries(C.blueprints).map(([file, text]) => { try { return [file, yaml.load(text)]; } catch (e) { return null; } }).filter(Boolean);
  $('#startFrom').innerHTML = opt('', 'Blank system') + presets.map(([f, raw]) => opt(f, raw.system)).join('') + opt('__paste', 'Paste YAML…');
  $('#startFrom').onchange = e => {
    const v = e.target.value;
    $('#pasteBox').hidden = v !== '__paste';
    if (v === '__paste') return;
    B = v ? fromBlueprint(presets.find(p => p[0] === v)[1]) : blank();
    if (v) { B.meta.id = B.meta.id + '-copy'; B.meta.system = B.meta.system + ' (copy)'; }
    renderForms();
  };
  $('#pasteLoad').onclick = () => {
    let raw; try { raw = yaml.load($('#pasteText').value); } catch (err) { return flash('That is not valid YAML: ' + (err.reason || err.message)); }
    if (!raw || !Array.isArray(raw.components)) return flash('That YAML has no components list.');
    B = fromBlueprint(raw); $('#pasteBox').hidden = true; renderForms(); flash('Loaded. Edit with the forms.');
  };
  $('#copyBtn').onclick = () => {
    const text = $('#yaml').textContent, btn = $('#copyBtn');
    const fallback = () => { const r = document.createRange(); r.selectNodeContents($('#yaml')); const s = window.getSelection(); s.removeAllRanges(); s.addRange(r); flash('Selected. Press Ctrl+C (Cmd+C) to copy.'); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(() => { btn.textContent = 'Copied'; setTimeout(() => { btn.textContent = 'Copy YAML'; }, 1500); }, fallback);
    else fallback();
  };

  renderForms();
  window.__builder = { get state() { return B; }, toYaml, fromBlueprint, setState: s => { B = s; renderForms(); } }; // for automated tests
})();
