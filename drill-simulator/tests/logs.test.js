// Logs must keep the whole shift, so a failure can be traced back to what happened earlier.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const yaml = require('../vendor/js-yaml.min.js');
const S = require('../src/engine.js');
const T = require('../src/tools.js');

const dir = p => path.join(__dirname, '..', p);
fs.readdirSync(dir('packs')).filter(f => f.endsWith('.yaml'))
  .forEach(f => S.registerPack(yaml.load(fs.readFileSync(dir('packs/' + f), 'utf8'))));
const bp = S.validateBlueprint(yaml.load(fs.readFileSync(dir('blueprints/trade-allocation-kafka.yaml'), 'utf8'))).blueprint;

test('a long run keeps the lines from the start, not only the latest 600', () => {
  const sim = new S.Simulator(bp, { seed: 42 });
  const steps = 12 * 3600 / 5; // twelve simulated hours: past the old 600-line limit
  for (let i = 0; i < steps; i++) sim.step(5);
  const busiest = Math.max(...Object.values(sim.c).map(c => c.logs.length));
  assert.ok(busiest > 600, 'the run produced more than 600 lines for a component (' + busiest + ')');
  Object.values(sim.c).forEach(c => {
    if (!c.logs.length) return;
    assert.ok(c.logs[0].t <= bp.start, c.def.id + ' still has lines from before the shift started');
  });
});

test('search can start from a clock time, and returns nothing earlier than it', () => {
  const sim = new S.Simulator(bp, { seed: 42 });
  for (let i = 0; i < 120 * 6; i++) sim.step(5); // about half an hour into the shift
  const res = T.search(sim, 'earliest=13:30 *');
  assert.ok(res.events.length > 0, 'the shift has lines');
  res.events.forEach(e => assert.ok(e.t >= bp.start, 'no line before 13:30: ' + S.clockStr(e.t, true)));
});
