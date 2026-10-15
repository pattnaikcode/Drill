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
      return `<div class="frow">
        <label class="field"><span>Time</span><input type="time" value="${esc(f.at)}" data-fat="${i}" aria-label="Fault time"></label>
        <label class="field"><span>Component</span><select data-fcomp="${i}">${compOpts}</select></label>
        <label class="field"><span>Fault</span><select data-fkey="${i}">${keyOpts}</select></label>
        <div class="fhint" style="padding-bottom:8px">${esc(cc && cc.faults.find(x => x.key === f.fault) ? cc.faults.find(x => x.key === f.fault).label : '')}</div>
        <button class="btn sm" data-act="rmFault" data-i="${i}">Remove</button>
      </div>`;
    }).join('') || '<p class="small muted">No faults yet. Add one below.</p>';

    const rootOpts = injected.map(f => `<option value="${esc(f.component + '|' + f.fault)}" ${rootValue === f.component + '|' + f.fault ? 'selected' : ''}>${esc(compLabel(f.component))}: ${esc(faultLabel(f.component, f.fault))}</option>`).join('');
    const acceptBoxes = actions.map(a => `<label><input type="checkbox" data-acc="${esc(a.key)}" ${uc.accepted_fixes.includes(a.key) ? 'checked' : ''}> ${esc(a.label)}</label>`).join('');
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
        <h2>Check</h2>${status}
      </section>
      </div>
      <div class="uout panel stack">
        <div class="row between"><h2>YAML for drills/${esc(uc.id)}.yaml</h2><button class="btn sm" data-act="copy">Copy</button></div>
        <pre id="yamlOut">${esc(yaml.dump(outputObject(), { lineWidth: 110 }))}</pre>
        <p class="fhint">Save this as a file in the <code>drills/</code> folder, then rebuild the app. The drill player and admin page read it from there.</p>
      </div>`;
  }

  app.addEventListener('change', e => {
    const t = e.target, d = t.dataset;
    if (d.act === 'sys') { sys = systems.find(b => b.id === t.value); uc = U.blankUseCase(sys, uc.title); }
    else if (d.f === 'title') { uc.title = t.value; uc.id = U.slug(t.value) || uc.id; }
    else if (d.f === 'level') uc.level = t.value;
    else if (d.f === 'brief') uc.brief = t.value;
    else if (d.fat !== undefined) uc.faults[+d.fat].at = t.value;
    else if (d.fcomp !== undefined) { const f = uc.faults[+d.fcomp]; f.component = t.value; const c = faultChoices().find(x => x.component === t.value); f.fault = c && c.faults[0] ? c.faults[0].key : f.fault; }
    else if (d.fkey !== undefined) uc.faults[+d.fkey].fault = t.value;
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
    else if (act === 'copy') {
      const text = yaml.dump(outputObject(), { lineWidth: 110 });
      try { navigator.clipboard.writeText(text); b.textContent = 'Copied'; setTimeout(() => { b.textContent = 'Copy'; }, 1200); } catch (err) { b.textContent = 'Select the text'; }
    }
  });

  render();
})();
