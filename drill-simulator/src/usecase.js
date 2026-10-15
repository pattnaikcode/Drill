/*
 * OpsPilot use case editor logic (no screen code).
 *
 * A use case is one drill file (drills/*.yaml). This module builds one from simple steps, the way a
 * form will: choose a component, choose one of its faults, choose a time, choose the right fix.
 * It offers only what the chosen system really has, and it checks the result with the same validator
 * the drill player uses, plus two rules a drill cannot be scored without: a root cause and at least
 * one accepted fix.
 */
(function (root) {
  'use strict';
  const S = (typeof module === 'object' && module.exports) ? require('./engine.js') : root.OpsSim;
  const D = (typeof module === 'object' && module.exports) ? require('./session.js') : root.OpsDrill;

  const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

  // what a form can offer for this system: every component, with its own faults (pack faults included)
  function faultChoices(bp) {
    return bp.components.map(c => ({
      component: c.id,
      name: c.name,
      faults: Object.entries(S.faultsForDef(c)).map(([key, f]) => ({ key, label: f.label, host: !!f.host })),
    })).filter(c => c.faults.length);
  }

  // every fix or risky action this system's components offer, as "component.action"
  function actionChoices(bp) {
    const out = [];
    bp.components.forEach(c => {
      Object.entries(S.actionsForDef(c)).forEach(([key, a]) => out.push({ key: c.id + '.' + key, label: `${a.label} (${c.name})`, fixes: a.fixes || [] }));
    });
    return out;
  }

  function blankUseCase(bp, title) {
    return {
      id: slug(title || 'new-use-case') || 'new-use-case',
      title: title || 'New use case',
      systems: [bp.id],
      level: 'Medium',
      brief: '',
      faults: [],
      root_cause: null,
      accepted_fixes: [],
      risky_actions: [],
      hints: [],
      debrief: {},
    };
  }

  function addFault(uc, f) { uc.faults.push({ at: f.at, component: f.component, fault: f.fault, ...(f.params && Object.keys(f.params).length ? { params: f.params } : {}) }); return uc; }
  function removeFault(uc, i) { uc.faults.splice(i, 1); return uc; }

  // the errors a responder would see if this use case were run now (empty array = ready)
  function check(uc, bp) {
    const errors = [];
    if (!uc.title) errors.push('Give the use case a title.');
    if (!/^[a-z0-9][a-z0-9-]*$/.test(String(uc.id || ''))) errors.push('The id must be lowercase letters, digits or dashes.');
    if (!uc.faults.length) errors.push('Add at least one fault.');
    if (!uc.root_cause) errors.push('Choose the root cause (the fault the responder should find).');
    if (!uc.accepted_fixes.length) errors.push('Choose at least one accepted fix, or the drill cannot be solved.');
    if (uc.root_cause && uc.faults.length) {
      const hit = uc.faults.some(f => f.component === uc.root_cause.component && f.fault === uc.root_cause.fault);
      if (!hit) errors.push('The root cause must be one of the faults you added.');
    }
    if (errors.length) return errors;
    return D.validateDrill(uc, bp); // the player's own rules: times inside the shift, components and faults exist
  }

  const UseCase = { faultChoices, actionChoices, blankUseCase, addFault, removeFault, check, slug };
  if (typeof module === 'object' && module.exports) module.exports = UseCase;
  else root.OpsUseCase = UseCase;
})(typeof globalThis !== 'undefined' ? globalThis : this);
