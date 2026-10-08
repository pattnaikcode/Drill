// Run with: node --test tests/
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const yaml = require('../vendor/js-yaml.min.js');
const S = require('../src/engine.js');
const D = require('../src/session.js');

const dir = p => path.join(__dirname, '..', p);
const bpText = f => fs.readFileSync(dir('blueprints/' + f), 'utf8');
const drills = fs.readdirSync(dir('drills')).sort().map(f => yaml.load(fs.readFileSync(dir('drills/' + f), 'utf8')));
const KAFKA = S.parseBlueprint(bpText('trade-allocation-kafka.yaml'), yaml).blueprint;
const DIRECT = S.parseBlueprint(bpText('trade-allocation-direct.yaml'), yaml).blueprint;

function run(drill, bp, responder, seed) {
  const sim = new S.Simulator(bp, { seed: 11 });
  const s = new D.Session(sim, drill, { mode: 'assessment', seed: seed || 1 });
  let step = 0;
  while (s.state === 'running' && step < 5000) { s.tick(5); responder(s, step++); }
  return s;
}

// a responder who follows the runbook: acknowledge, diagnose, apply each accepted fix in order
function good(s) {
  if (s.firstAlertAt() !== null && s.ackAt === null) s.acknowledge('Test responder');
  if (s.ackAt !== null && !s.declarations.length && s.sim.t >= s.firstAlertAt() + 120) s.declare(s.sc.root_cause.component, s.sc.root_cause.fault);
  if (s.declarations.length) {
    const next = s.sc.accepted_fixes.find(k => !s.actions.some(a => a.key === k));
    if (next) {
      const [c, a] = next.split('.');
      if (a === 'reprocess_rejected' && s.sim.activeFaults().length) return; // fix the data first
      s.requestAction(c, a, 'Approver', true);
    } else if (s.sim.pendingRepair().rejected >= 1 && !s.sim.activeFaults().length) {
      s.requestAction('tam', 'reprocess_rejected', 'Approver', true);
    }
  }
}

// a responder who acknowledges late and restarts the allocator
function bad(s) {
  if (s.firstAlertAt() !== null && s.sim.t > s.firstAlertAt() + 1500 && s.ackAt === null) {
    s.acknowledge('Test responder');
    s.declare('tam', 'instances_lost' === s.sc.root_cause.fault ? 'instances_lost' : 'instances_lost');
    s.requestAction('tam', 'restart', 'Approver', true);
  }
}

test('both blueprints are valid', () => {
  assert.ok(KAFKA && DIRECT);
  assert.deepStrictEqual(KAFKA.chains, [['oms', 'trades_topic', 'tam', 'ctm', 'settle']]);
  assert.deepStrictEqual(DIRECT.chains, [['oms', 'tam', 'ctm', 'settle']]);
});

test('blueprint validation catches common mistakes', () => {
  const errs = t => S.parseBlueprint(t, yaml).errors.join('\n');
  assert.match(errs('system: x\ncomponents:\n  - {id: a, type: kafkaa}\nflow: [a -> b]'), /unknown type "kafkaa"/);
  assert.match(errs(bpText('trade-allocation-kafka.yaml').replace('oms -> trades_topic', 'oms -> trades_tpoic')), /unknown component "trades_tpoic"/);
  assert.match(errs(bpText('trade-allocation-kafka.yaml').replace('metric: lag,', 'metric: lagg,')), /no metric "lagg"/);
  assert.match(errs(bpText('trade-allocation-kafka.yaml').replace('partitions: 6', 'partitions: 0')), /"partitions" is required/);
  assert.match(errs('system: [unclosed'), /YAML syntax/);
});

test('steady state is healthy with no alerts', () => {
  for (const bp of [KAFKA, DIRECT]) {
    const sim = new S.Simulator(bp, { seed: 3 });
    for (let i = 0; i < 120; i++) sim.step(5);
    assert.strictEqual(sim.alerts.length, 0, bp.id + ' should not alert when healthy');
    assert.ok(Object.keys(sim.c).every(id => sim.health(id) === 'ok'));
  }
});

test('Kafka-only drills are rejected on the blueprint without Kafka', () => {
  const stuck = drills.find(d => d.id === 'stuck-partition');
  assert.match(D.validateDrill(stuck, DIRECT).join(), /trades_topic/);
  assert.deepStrictEqual(D.validateDrill(stuck, KAFKA), []);
});

for (const drill of drills) {
  test(`drill "${drill.id}" is valid on the Kafka blueprint`, () => assert.deepStrictEqual(D.validateDrill(drill, KAFKA), []));
  const seeds = drill.mystery ? [1, 2, 3, 4, 5, 6, 7, 8] : [1];
  for (const seed of seeds) {
    test(`drill "${drill.id}"${drill.mystery ? ' seed ' + seed : ''}: good responder recovers before cut-off`, () => {
      const s = run(drill, KAFKA, good, seed);
      const sc = s.score();
      assert.strictEqual(s.endReason, 'recovered', `ended with ${s.endReason}; ${JSON.stringify(sc.parts)}`);
      assert.ok(sc.total >= 85, `score ${sc.total}: ${JSON.stringify(sc.parts)}`);
    });
  }
  test(`drill "${drill.id}": careless responder scores low`, () => {
    const s = run(drill, KAFKA, bad, 3);
    assert.ok(s.score().total < 50, `score ${s.score().total}`);
  });
}

test('restarting the consumer does not clear a poison message', () => {
  const sim = new S.Simulator(KAFKA, { seed: 5 });
  sim.injectFault('trades_topic', 'poison_message', { partition: 2 });
  for (let i = 0; i < 60; i++) sim.step(5);
  sim.applyAction('tam', 'restart');
  for (let i = 0; i < 60; i++) sim.step(5);
  assert.ok(sim.metric('trades_topic', 'max_partition_lag') > 200);
  assert.strictEqual(sim.activeFaults().length, 1);
});

test('actions need a named approver and confirmation', () => {
  const sim = new S.Simulator(KAFKA, { seed: 5 });
  const s = new D.Session(sim, drills[0], {});
  assert.strictEqual(s.requestAction('tam', 'scale_out', '', true).ok, false);
  assert.strictEqual(s.requestAction('tam', 'scale_out', 'Rahul', false).ok, false);
  assert.strictEqual(s.actions.length, 0);
});
