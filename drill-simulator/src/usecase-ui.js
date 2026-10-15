/*
 * OpsPilot Use Case Builder: the form on top of src/usecase.js.
 * Every change re-checks the use case and rewrites the YAML on the right, so a problem shows
 * where it is written rather than only after saving.
 */
(function () {
  'use strict';
  const S = window.OpsSim, U = window.OpsUseCase, yaml = window.jsyaml, C = window.DRILL_CONTENT;
  const app = document.getElementById('app');
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // packs first, so the systems that use them load
  C.packs.forEach(t => S.registerPack(yaml.load(t)));
  const systems = Object.values(C.blueprints).map(text => S.parseBlueprint(text, yaml))
    .filter(r => r.blueprint).map(r => r.blueprint)
    .sort((a, b) => a.system.localeCompare(b.system));

  let sys = systems.find(b => b.id === C.default_blueprint) || systems[0];
  let uc = U.blankUseCase(sys, 'New use case');
  const faultChoices = () => U.faultChoices(sys);
  const actionChoices = () => U.actionChoices(sys);
  const toggle = (list, v, on) => { const i = list.indexOf(v); if (on && i < 0) list.push(v); if (!on && i >= 0) list.splice(i, 1); };
  const hhmm = m => S.clockStr(sys.start + m * 60, false);
  const faultDef = (cid, key) => { const c = sys.byId[cid]; return c && S.faultsForDef(c)[key]; };
  const paramDefaults = (cid, key) => { const f = faultDef(cid, key); return (f && f.params) || {}; };
  const save = { port: 3000 };

  function outputObject() {
    const o = { id: uc.id, title: uc.title, systems: uc.systems, level: uc.level };
    if (uc.brief) o.brief = uc.brief;
    o.faults = uc.faults.map(f => ({ at: f.at, component: f.component, fault: f.fault, ...(f.params ? { params: f.params } : {}) }));
    if (uc.root_cause) o.root_cause = uc.root_cause;
    if (uc.accepted_fixes.length) o.accepted_fixes = uc.accepted_fixes;
    if (uc.risky_actions.length) o.risky_actions = uc.risky_actions;
    if (uc.hints.length) o.hints = uc.hints;
    if (Object.keys(uc.debrief).length) o.debrief = uc.debrief;
    return o;
  }

  function render() {
    const errors = U.check(uc, sys);
    const choices = faultChoices(), actions = actionChoices();
    const injected = [...new Map(uc.faults.map(f => [f.component + '|' + f.fault, f])).values()];
    const rootValue = uc.root_cause ? uc.root_cause.component + '|' + uc.root_cause.fault : '';
    const compLabel = id => (sys.byId[id] ? sys.byId[id].name : id);
    const faultLabel = (cid, key) => { const c = choices.find(x => x.component === cid); const f = c && c.faults.find(x => x.key === key); return f ? f.label : key; };

    const faultRows = uc.faults.map((f, i) => {
      const cc = choices.find(x => x.component === f.component) || choices[0];
      const compOpts = choices.map(c => `<option value="${esc(c.component)}" ${c.component === f.component ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
      const keyOpts = (cc ? cc.faults : []).map(x => `<option value="${esc(x.key)}" ${x.key === f.fault ? 'selected' : ''}>${esc(x.label)}</option>`).join('');
      const defs = paramDefaults(f.component, f.fault), cur = Object.assign({}, defs, f.params || {});
      const paramFields = Object.keys(defs).map(k => `<label class="field"><span>${esc(k)}</span><input type="${typeof defs[k] === 'number' ? 'number' : 'text'}" value="${esc(cur[k])}" data-fparam="${i}" data-pkey="${esc(k)}"></label>`).join('');
      return `<div class="frow">
        <label class="field"><span>Time</span><input type="time" value="${esc(f.at)}" data-fat="${i}" aria-label="Fault time"></label>
        <label class="field"><span>Component</span><select data-fcomp="${i}">${compOpts}</select></label>
        <label class="field"><span>Fault</span><select data-fkey="${i}">${keyOpts}</select></label>
        <div class="fhint" style="padding-bottom:8px">${esc(cc && cc.faults.find(x => x.key === f.fault) ? cc.faults.find(x => x.key === f.fault).label : '')}</div>
        <button class="btn sm" data-act="rmFault" data-i="${i}">Remove</button>
        ${paramFields ? `<div class="fgrid wide">${paramFields}<p class="fhint wide">Defaults come from the fault. Change one only if the drill needs it.</p></div>` : ''}
      </div>`;
    }).join('') || '<p class="small muted">No faults yet. Add one below.</p>';

    const rootOpts = injected.map(f => `<option value="${esc(f.component + '|' + f.fault)}" ${rootValue === f.component + '|' + f.fault ? 'selected' : ''}>${esc(compLabel(f.component))}: ${esc(faultLabel(f.component, f.fault))}</option>`).join('');
    const acceptBoxes = actions.map(a => `<label><input type="checkbox" data-acc="${esc(a.key)}" ${uc.accepted_fixes.includes(a.key) ? 'checked' : ''}> ${esc(a.label)}</label>`).join('');
    const hintRows = uc.hints.map((h, i) => `<div class="frow"><label class="field"><span>After (min)</span><input type="number" min="0" value="${esc(h.after_min)}" data-hmin="${i}"></label><label class="field wide"><span>Hint</span><input type="text" value="${esc(h.text)}" data-htext="${i}"></label><button class="btn sm" data-act="rmHint" data-i="${i}">Remove</button></div>`).join('');
    const riskBoxes = actions.map(a => `<label><input type="checkbox" data-risk="${esc(a.key)}" ${uc.risky_actions.includes(a.key) ? 'checked' : ''}> ${esc(a.label)}</label>`).join('');
    const sysOpts = systems.map(b => `<option value="${esc(b.id)}" ${b.id === sys.id ? 'selected' : ''}>${esc(b.system)}</option>`).join('');
    const lvl = ['Easy', 'Medium', 'Hard'].map(l => `<option ${uc.level === l ? 'selected' : ''}>${l}</option>`).join('');

    const status = errors.length
      ? `<ul class="errs">${errors.map(e => `<li>${esc(e)}</li>`).join('')}</ul>`
      : '<p class="pass">Ready: this use case can be run and scored.</p>';

    app.innerHTML = `
      <div class="wrap-sec">
      <section class="panel stack">
        <h2>1. The use case</h2>
        <div class="fgrid">
          <label class="field"><span>System</span><select data-act="sys">${sysOpts}</select></label>
          <label class="field"><span>Title</span><input type="text" value="${esc(uc.title)}" data-f="title"></label>
          <label class="field"><span>Level</span><select data-f="level">${lvl}</select></label>
          <label class="field wide"><span>Brief (what the responder is told)</span><textarea rows="3" data-f="brief">${esc(uc.brief)}</textarea></label>
        </div>
        <p class="fhint">Id for the file: <code>${esc(uc.id)}</code>. Faults must fall between ${S.clockStr(sys.start)} and ${S.clockStr(sys.cutoff)}.</p>
      </section>
      <section class="panel stack">
        <h2>2. Faults</h2>
        <p class="fhint">Each fault switches on at its time. Pick a component first, then the fault that component can have.</p>
        <div class="wrap-sec">${faultRows}</div>
        <div><button class="btn sm" data-act="addFault">Add fault</button></div>
      </section>
      <section class="panel stack">
        <h2>3. The answer</h2>
        <label class="field"><span>Root cause (the fault the responder should find)</span>
          <select data-f="root"><option value="">Choose…</option>${rootOpts}</select></label>
        <div class="fgrid">
          <div class="field"><span>Accepted fixes (scored as right)</span><div class="chk">${acceptBoxes}</div></div>
          <div class="field"><span>Risky actions (scored as harmful)</span><div class="chk">${riskBoxes}</div></div>
        </div>
      </section>
      <section class="panel stack">
        <h2>4. Hints (practice mode)</h2>
        <p class="fhint">A hint appears after the given number of minutes. Assessment mode never shows hints.</p>
        ${hintRows || '<p class="small muted">No hints. Add one below if the responder needs a nudge.</p>'}
        <div><button class="btn sm" data-act="addHint">Add hint</button></div>
      </section>
      <section class="panel stack">
        <h2>5. Debrief (shown after the drill)</h2>
        <div class="fgrid">
          <label class="field wide"><span>What happened</span><textarea rows="2" data-deb="what_happened">${esc(uc.debrief.what_happened || '')}</textarea></label>
          <label class="field wide"><span>The key signal the responder should have seen</span><textarea rows="2" data-deb="key_signal">${esc(uc.debrief.key_signal || '')}</textarea></label>
          <label class="field wide"><span>Why the wrong fixes do not work</span><textarea rows="2" data-deb="why_not_restart">${esc(uc.debrief.why_not_restart || '')}</textarea></label>
          <label class="field wide"><span>Runbook, one step per line</span><textarea rows="3" data-deb="runbook">${esc((uc.debrief.runbook || []).join('\n'))}</textarea></label>
        </div>
      </section>
      <section class="panel stack">
        <h2>Check</h2>${status}
      </section>
      </div>
      <div class="uout panel stack">
        <div class="row between"><h2>YAML for drills/${esc(uc.id)}.yaml</h2><button class="btn sm" data-act="copy">Copy</button></div>
        <pre id="yamlOut">${esc(yaml.dump(outputObject(), { lineWidth: 110 }))}</pre>
        <div class="row" style="gap:10px;align-items:flex-end;flex-wrap:wrap">
          <label class="field"><span>Simulator server port</span><input type="number" value="${save.port}" data-f="port" style="width:110px"></label>
          <button class="btn" data-act="save" ${errors.length ? 'disabled' : ''}>Save to drills folder</button>
        </div>
        <p id="saveMsg" class="small" role="status"></p>
        <p class="fhint">Saving needs the simulator server running on this machine (<code>node src/server.js --blueprint ${esc(sys.id)}.yaml</code>). Then run <code>node build.py</code> to add the use case to the app.</p>
      </div>`;
  }

  // saves through the simulator server on this machine; the server checks the use case again before writing
  function saveDrill(btn) {
    const msg = document.getElementById('saveMsg');
    const text = yaml.dump(outputObject(), { lineWidth: 110 });
    const post = overwrite => fetch(`http://localhost:${save.port}/api/drills`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ drill: text, overwrite }),
    }).then(r => r.json().then(j => ({ status: r.status, j })));
    msg.textContent = 'Saving…';
    post(false).then(({ status, j }) => {
      if (j.ok) { msg.textContent = `Saved ${j.file}. ${j.note}`; return; }
      if (status === 409 && window.confirm(j.errors[0] + '\nReplace it?')) {
        return post(true).then(r => { msg.textContent = r.j.ok ? `Replaced ${r.j.file}. ${r.j.note}` : 'Not saved: ' + r.j.errors.join(' '); });
      }
      msg.textContent = 'Not saved: ' + j.errors.join(' ');
    }).catch(() => { msg.textContent = `Could not reach the simulator server on port ${save.port}. Start it, or use Copy and save the file yourself.`; });
  }

  app.addEventListener('change', e => {
    const t = e.target, d = t.dataset;
    if (d.act === 'sys') { sys = systems.find(b => b.id === t.value); uc = U.blankUseCase(sys, uc.title); }
    else if (d.f === 'title') { uc.title = t.value; uc.id = U.slug(t.value) || uc.id; }
    else if (d.f === 'level') uc.level = t.value;
    else if (d.f === 'port') save.port = +t.value;
    else if (d.f === 'brief') uc.brief = t.value;
    else if (d.fat !== undefined) uc.faults[+d.fat].at = t.value;
    else if (d.fcomp !== undefined) { const f = uc.faults[+d.fcomp]; f.component = t.value; delete f.params; const c = faultChoices().find(x => x.component === t.value); f.fault = c && c.faults[0] ? c.faults[0].key : f.fault; }
    else if (d.fkey !== undefined) { const f = uc.faults[+d.fkey]; f.fault = t.value; delete f.params; }
    else if (d.fparam !== undefined) { const f = uc.faults[+d.fparam]; const def = paramDefaults(f.component, f.fault)[d.pkey]; f.params = Object.assign({}, f.params || {}, { [d.pkey]: typeof def === 'number' ? Number(t.value) : t.value }); }
    else if (d.hmin !== undefined) uc.hints[+d.hmin].after_min = Number(t.value);
    else if (d.htext !== undefined) uc.hints[+d.htext].text = t.value;
    else if (d.deb !== undefined) {
      const v = d.deb === 'runbook' ? t.value.split('\n').map(s => s.trim()).filter(Boolean) : t.value.trim();
      if (!v || (Array.isArray(v) && !v.length)) delete uc.debrief[d.deb]; else uc.debrief[d.deb] = v;
    }
    else if (d.f === 'root') uc.root_cause = t.value ? { component: t.value.split('|')[0], fault: t.value.split('|')[1] } : null;
    else if (d.acc !== undefined) toggle(uc.accepted_fixes, d.acc, t.checked);
    else if (d.risk !== undefined) toggle(uc.risky_actions, d.risk, t.checked);
    render();
  });

  app.addEventListener('click', e => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    if (act === 'addFault') {
      const c = faultChoices()[0];
      if (!c) return;
      U.addFault(uc, { at: hhmm(15), component: c.component, fault: c.faults[0].key });
      render();
    } else if (act === 'rmFault') { U.removeFault(uc, +b.dataset.i); render(); }
    else if (act === 'addHint') { uc.hints.push({ after_min: 2, text: '' }); render(); }
    else if (act === 'rmHint') { uc.hints.splice(+b.dataset.i, 1); render(); }
    else if (act === 'save') saveDrill(b);
    else if (act === 'copy') {
      const text = yaml.dump(outputObject(), { lineWidth: 110 });
      try { navigator.clipboard.writeText(text); b.textContent = 'Copied'; setTimeout(() => { b.textContent = 'Copy'; }, 1200); } catch (err) { b.textContent = 'Select the text'; }
    }
  });

  render();
})();
