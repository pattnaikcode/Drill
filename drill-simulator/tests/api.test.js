// The observability API: metric timestamps must be the simulated time each sample was taken.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const yaml = require('../vendor/js-yaml.min.js');
const S = require('../src/engine.js');
const SimulatorAPI = require('../src/api.js');

const dir = p => path.join(__dirname, '..', p);
fs.readdirSync(dir('packs')).filter(f => f.endsWith('.yaml'))
  .forEach(f => S.registerPack(yaml.load(fs.readFileSync(dir('packs/' + f), 'utf8'))));

function loadSim(file, seed) {
  const r = S.validateBlueprint(yaml.load(fs.readFileSync(dir('examples/' + file), 'utf8')));
  assert.deepStrictEqual(r.errors, [], file);
  return new S.Simulator(r.blueprint, { seed });
}

test('metric points carry the simulated time of each sample, not an estimate', () => {
  const sim = loadSim('bank-cards-upi.yaml', 7);
  for (let i = 0; i < 120; i++) sim.step(5); // ten simulated minutes after the warm-up
  const api = new SimulatorAPI(sim);
  const res = api.queryMetrics({ component: 'card_switch', metric: 'error_rate' });
  assert.ok(res.points.length > 5, 'several samples returned');
  res.points.forEach((p, i) => {
    assert.strictEqual(p.t, sim.history.t[i], 'timestamp ' + i + ' matches the sampled time');
    assert.strictEqual(p.v, sim.c.card_switch.hist.error_rate[i], 'value ' + i + ' matches its sample');
  });
  // samples are one minute apart
  for (let i = 1; i < res.points.length; i++) assert.ok(res.points[i].t - res.points[i - 1].t >= 60);
});

test('the default window starts at the first sample, including the warm-up', () => {
  const sim = loadSim('bank-cards-upi.yaml', 7);
  for (let i = 0; i < 24; i++) sim.step(5);
  const res = new SimulatorAPI(sim).queryMetrics({ component: 'card_switch', metric: 'error_rate' });
  assert.strictEqual(res.from_t, sim.history.t[0]);
  assert.ok(res.from_t < sim.bp.start, 'warm-up samples are included');
});

test('an unknown component or metric is reported, not guessed', () => {
  const sim = loadSim('bank-cards-upi.yaml', 7);
  const api = new SimulatorAPI(sim);
  assert.match(api.queryMetrics({ component: 'nope', metric: 'error_rate' }).error, /not found/);
  assert.match(api.queryMetrics({ component: 'card_switch', metric: 'nope' }).error, /not found/);
});
