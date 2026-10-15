// The use case editor logic: choices offered for a system, and checks that match the drill player.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const yaml = require('../vendor/js-yaml.min.js');
const S = require('../src/engine.js');
const U = require('../src/usecase.js');

const dir = p => path.join(__dirname, '..', p);
fs.readdirSync(dir('packs')).filter(f => f.endsWith('.yaml'))
  .forEach(f => S.registerPack(yaml.load(fs.readFileSync(dir('packs/' + f), 'utf8'))));
const bp = S.validateBlueprint(yaml.load(fs.readFileSync(dir('examples/web-shop-generic.yaml'), 'utf8'))).blueprint;

test('the editor offers only the faults and actions this system really has', () => {
  const faults = U.faultChoices(bp);
  const topic = faults.find(c => c.component === 'order_events');
  assert.ok(topic, 'the Kafka topic can have faults');
  assert.ok(topic.faults.some(f => f.key === 'poison_message'));
  assert.ok(!faults.some(c => c.component === 'nope'));
  const actions = U.actionChoices(bp);
  assert.ok(actions.some(a => a.key === 'order_events.skip_poison_message' && a.fixes.includes('poison_message')));
  assert.ok(!actions.some(a => a.key.startsWith('orders_db.') && a.key.endsWith('skip_poison_message')));
});

test('an empty use case says what is missing', () => {
  const errs = U.check(U.blankUseCase(bp, 'Order events stuck'), bp);
  assert.ok(errs.some(e => /at least one fault/.test(e)));
  assert.ok(errs.some(e => /root cause/.test(e)));
  assert.ok(errs.some(e => /accepted fix/.test(e)));
});

test('a complete use case passes, and survives a YAML round trip', () => {
  const uc = U.blankUseCase(bp, 'Order events stuck');
  U.addFault(uc, { at: '18:20', component: 'order_events', fault: 'poison_message' });
  uc.root_cause = { component: 'order_events', fault: 'poison_message' };
  uc.accepted_fixes = ['order_events.skip_poison_message'];
  assert.deepStrictEqual(U.check(uc, bp), []);
  const back = yaml.load(yaml.dump(uc));
  assert.deepStrictEqual(U.check(back, bp), []);
});

test('faults outside the shift, unknown faults and a root cause that was never injected are caught', () => {
  const uc = U.blankUseCase(bp, 'Checks');
  uc.accepted_fixes = ['order_events.skip_poison_message'];
  U.addFault(uc, { at: '08:00', component: 'order_events', fault: 'poison_message' });
  uc.root_cause = { component: 'order_events', fault: 'poison_message' };
  assert.ok(U.check(uc, bp).some(e => /between this system's start/.test(e)));

  uc.faults = [];
  U.addFault(uc, { at: '18:20', component: 'order_events', fault: 'rebalance_storm' });
  assert.ok(U.check(uc, bp).some(e => /root cause must be one of the faults/.test(e)));

  uc.faults = [];
  U.addFault(uc, { at: '18:20', component: 'order_events', fault: 'made_up' });
  uc.root_cause = { component: 'order_events', fault: 'made_up' };
  assert.ok(U.check(uc, bp).some(e => /no fault "made_up"/.test(e)));
});

test('removing a fault updates the use case', () => {
  const uc = U.blankUseCase(bp, 'Removal');
  U.addFault(uc, { at: '18:10', component: 'order_events', fault: 'poison_message' });
  U.addFault(uc, { at: '18:12', component: 'order_events', fault: 'rebalance_storm' });
  U.removeFault(uc, 0);
  assert.strictEqual(uc.faults.length, 1);
  assert.strictEqual(uc.faults[0].fault, 'rebalance_storm');
});
