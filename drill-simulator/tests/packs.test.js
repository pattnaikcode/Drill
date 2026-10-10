// Every component in the pack library: each fault shows up, and the action that says it fixes it does.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const yaml = require('../vendor/js-yaml.min.js');
const S = require('../src/engine.js');

const dir = p => path.join(__dirname, '..', p);
const packs = fs.readdirSync(dir('packs')).filter(f => f.endsWith('.yaml')).map(f => yaml.load(fs.readFileSync(dir('packs/' + f), 'utf8')));
packs.forEach(p => { const e = S.registerPack(p); if (e.length) throw new Error(p.pack + ': ' + e.join('; ')); });

// the smallest system that puts a component of this type to work
function miniSystem(type) {
  const b = S.PACK_TYPES[type].behaves_like;
  const comps = [
    { id: 'src', type: 'source', name: 'Clients', rate_per_min: 700 },
    { id: 'svc', type: 'service', name: 'App', capacity_per_min: 1000, instances: 2 },
    { id: 'ext', type: 'external_party', name: 'Partner', capacity_per_min: 1200 },
  ];
  let flow;
  const x = { id: 'x', type, name: 'Under test' };
  if (b === 'service') { comps.push(x); flow = ['src -> x -> svc -> ext']; }
  else if (b === 'source') { comps.shift(); comps.push(x); flow = ['x -> svc -> ext']; }
  else if (b === 'external_party') { comps.push(x); flow = ['src -> svc -> x']; comps.splice(2, 1); }
  else { comps[1].uses = ['x']; comps.push(x); flow = ['src -> svc -> ext']; }
  const r = S.validateBlueprint({ id: 't-' + type, system: 'Test ' + type, clock: { start: '09:00', cutoff: '10:00' }, components: comps, flow });
  assert.deepStrictEqual(r.errors, [], type + ': ' + r.errors.join('; '));
  return r.blueprint;
}

const ref = /\{[A-Za-z_]+\}/;

test('every pack type has a label, help text and works in a minimal system', () => {
  Object.entries(S.PACK_TYPES).forEach(([t, P]) => {
    assert.ok(P.label && P.help, t + ' needs a label and help');
    const sim = new S.Simulator(miniSystem(t), { seed: 3 });
    for (let i = 0; i < 120; i++) sim.step(5);
    assert.deepStrictEqual(sim.activeFaults(), [], t + ' should be healthy');
    Object.values(sim.c).forEach(s => s.logs.forEach(l => assert.ok(!ref.test(l.msg), `${t}: unfilled placeholder in "${l.msg}"`)));
  });
});

test('every pack fault has visible effects and its fixing action clears it', () => {
  let n = 0;
  Object.entries(S.PACK_TYPES).forEach(([t, P]) => {
    Object.entries(P.faults || {}).forEach(([fk, F]) => {
      const sim = new S.Simulator(miniSystem(t), { seed: 5 });
      sim.injectFault('x', fk);
      for (let i = 0; i < 120; i++) sim.step(5);
      const all = Object.values(sim.c).flatMap(s => s.logs).filter(l => l.t >= sim.bp.start);
      all.forEach(l => assert.ok(!ref.test(l.msg), `${t}.${fk}: unfilled placeholder in "${l.msg}"`));
      Object.values(F.evidence || {}).forEach(e => assert.ok(!ref.test(sim.packText(sim.c.x, e)), `${t}.${fk}: unfilled placeholder in evidence`));
      // something an engineer could see: an error/warning log, a growing queue, rejects or a stale feed
      const errs = all.filter(l => l.level === 'ERROR' || l.level === 'WARN').length;
      const stuck = Object.values(sim.c).reduce((a, s) => a + (s.inbox || 0) + (s.held || 0) + (s.rejected || 0) + (s.retry || 0) + (s.failed || 0), 0);
      const stale = sim.c.x.type === 'ref_data' && sim.metric('x', 'staleness_min') > sim.c.x.def.stale_after_min;
      assert.ok(errs >= 3 && (stuck > 100 || stale || F.effect.pool_full || sim.metric('x', 'error_rate') >= 10), `${t}.${fk}: no visible effect (errors ${errs}, stuck ${stuck})`);
      const fixers = Object.entries(P.actions || {}).filter(([, A]) => (A.fixes || []).includes(fk));
      assert.ok(fixers.length, `${t}.${fk}: no action fixes it`);
      fixers.forEach(([ak, A]) => {
        const s2 = new S.Simulator(miniSystem(t), { seed: 5 });
        s2.injectFault('x', fk);
        for (let i = 0; i < 24; i++) s2.step(5);
        const r = s2.applyAction('x', ak);
        assert.ok(r.ok && !ref.test(r.message) && !ref.test(r.label), `${t}.${ak}: ${r.message}`);
        for (let i = 0; i < Math.ceil(((A.after_s || 0) + 30) / 5); i++) s2.step(5);
        assert.deepStrictEqual(s2.activeFaults().filter(f => f.id === 'x'), [], `${t}.${ak} should fix ${fk}`);
        n++;
      });
    });
  });
  assert.ok(n >= 50, 'library should have plenty of fixes, got ' + n);
});

test('pack shell commands fill every placeholder', () => {
  Object.entries(S.PACK_TYPES).forEach(([t, P]) => {
    const sim = new S.Simulator(miniSystem(t), { seed: 3 });
    Object.values(P.shell || {}).forEach(o => assert.ok(!ref.test(sim.packText(sim.c.x, o)), `${t}: unfilled placeholder in shell output`));
  });
});

test('the library covers each sector', () => {
  const ids = packs.map(p => p.pack);
  ['capital-markets', 'retail-banking', 'retail-ecommerce', 'insurance', 'issuance'].forEach(p => assert.ok(ids.includes(p), p));
});
