// "Follow an order": traced orders move hop by hop through the live simulation.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const yaml = require('../vendor/js-yaml.min.js');
const S = require('../src/engine.js');
require('../src/trace.js');
const T = require('../src/tools.js');

const bp = S.parseBlueprint(fs.readFileSync(path.join(__dirname, '../blueprints/exchange.yaml'), 'utf8'), yaml).blueprint;
const hashPart = (sym, n) => [...sym].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % n;
function run(fault, journey, warmSteps = 24) {
  const sim = new S.Simulator(bp, { seed: 5 });
  if (fault) sim.injectFault(...fault);
  for (let i = 0; i < warmSteps; i++) sim.step(5);
  const tr = sim.sendOrder(journey || 'filled');
  for (let i = 0; i < 12; i++) sim.step(5);
  return { sim, tr, at: tr.journey.steps[Math.min(tr.step, tr.journey.steps.length - 1)].at };
}

test('journeys validate, and mistakes are explained', () => {
  assert.strictEqual(bp.journeys.length, 3);
  const text = fs.readFileSync(path.join(__dirname, '../blueprints/exchange.yaml'), 'utf8');
  assert.match(S.parseBlueprint(text.replace('- at: risk\n        does: "Checks the price against today\'s KONSTL', '- at: md_publisher\n        does: "Checks the price against today\'s KONSTL'), yaml).errors.join(), /does not send to/);
  assert.match(S.parseBlueprint(text.replace('"orders: update status=NEW"]', '"ordrs: update status=NEW"]'), yaml).errors.join(), /unknown table "ordrs"/);
});

test('healthy: all three journeys finish and write the right rows', () => {
  const sim = new S.Simulator(bp, { seed: 5 });
  ['filled', 'rejected', 'partial'].forEach(j => sim.sendOrder(j));
  for (let i = 0; i < 3; i++) sim.step(5);
  assert.deepStrictEqual(sim.traces.map(t => t.status).reverse(), ['done', 'rejected', 'done']);
  const orders = T.sql(sim, 'orderbook_db', 'SELECT symbol, status, filled_qty FROM orders ORDER BY symbol').rows;
  assert.deepStrictEqual(orders, [['CHLKFD', 'PARTIALLY_FILLED', 600], ['KONSTL', 'FILLED', 100], ['MAHPWR', 'REJECTED', 0]]);
  assert.strictEqual(T.sql(sim, 'orderbook_db', "SELECT * FROM trades WHERE clearing_status = 'ACCEPTED'").rows.length, 2);
  assert.match(T.sql(sim, 'orderbook_db', 'DELETE FROM orders').error, /read-only/);
});

test('faults stop the order where the problem is', () => {
  const p = hashPart('KONSTL', 8);
  let r = run(['trade_bus', 'poison_message', { partition: p }]);
  assert.strictEqual(r.tr.status, 'waiting'); assert.strictEqual(r.at, 'trade_bus'); assert.match(r.tr.reason, new RegExp(`partition ${p}`));
  r = run(['trade_bus', 'poison_message', { partition: (p + 1) % 8 }]);
  assert.strictEqual(r.tr.status, 'done', 'a stuck partition only blocks orders keyed to it');
  r = run(['issuer_2', 'announcement_missed']);
  assert.strictEqual(r.tr.status, 'rejected'); assert.strictEqual(r.at, 'risk'); assert.match(r.tr.reason, /band not updated/);
  r = run(['orderbook_db', 'disk_full']);
  assert.strictEqual(r.at, 'matching'); assert.match(r.tr.reason, /commits hang/);
  r = run(['clearing', 'cert_expired']);
  assert.strictEqual(r.at, 'clearing'); assert.match(r.tr.reason, /certificate has expired/);
  r = run(['fix_gateway', 'clock_skew']);
  assert.strictEqual(r.at, 'broker_a'); assert.match(r.tr.reason, /SendingTime/);
  const rows = T.sql(r.sim, 'orderbook_db', 'SELECT * FROM orders').rows;
  assert.strictEqual(rows.length, 0, 'an order that never reached the gateway has no row');
});

test('a stuck order resumes once the fault is fixed', () => {
  const r = run(['clearing', 'cert_expired']);
  assert.strictEqual(r.tr.status, 'waiting');
  r.sim.applyAction('clearing', 'renew_certificate');
  for (let i = 0; i < 120 && r.tr.status !== 'done'; i++) r.sim.step(5);
  assert.strictEqual(r.tr.status, 'done');
  assert.ok(r.tr.done[r.tr.done.length - 1].waited > 50, 'records how long it waited');
});
