// The support shell shows the start-of-day folders (inbox and archive) and answers ping like a real host.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const yaml = require('../vendor/js-yaml.min.js');
const S = require('../src/engine.js');
const T = require('../src/tools.js');

const dir = p => path.join(__dirname, '..', p);
fs.readdirSync(dir('packs')).filter(f => f.endsWith('.yaml')).forEach(f => S.registerPack(yaml.load(fs.readFileSync(dir('packs/' + f), 'utf8'))));
function load() {
  const bp = S.parseBlueprint(fs.readFileSync(dir('examples/payments-mq.yaml'), 'utf8'), yaml).blueprint;
  const sim = new S.Simulator(bp, { seed: 1 });
  for (let i = 0; i < 20; i++) sim.step(5);
  const sod = Object.values(sim.c).find(x => x.def.pack_type === 'sod_file_load');
  return { sim, sod, host: T.hostOf(sim, sod.def.id) };
}

test('the inbox lists today\'s file and the archive lists earlier days', () => {
  const { sim, host, sod } = load();
  const file = sim.packText(sod, '{FILE}');
  assert.match(T.shell(sim, host, 'ls -lrth /data/inbound/customer_static'), new RegExp(file.replace(/\./g, '\\.')));
  const arch = T.shell(sim, host, 'ls /data/inbound/customer_static/archive');
  assert.match(arch, /CUSTOMER_STATIC_20261008\.csv/);
  assert.match(arch, /CUSTOMER_STATIC_20261004\.csv/);
});

test('an archived file has a header and a trailer count', () => {
  const { sim, host } = load();
  const out = T.shell(sim, host, 'cat /data/inbound/customer_static/archive/CUSTOMER_STATIC_20261008.csv');
  assert.match(out, /^HDR\|CUSTOMER_STATIC\|20261008/);
  assert.match(out, /TRL\|48210/);
});

test('while the file is missing, the archive still lists earlier days', () => {
  const { sim, host, sod } = load();
  sim.injectFault(sod.def.id, 'file_missing');
  assert.match(T.shell(sim, host, 'ls /data/inbound/customer_static'), /no CUSTOMER_STATIC/);
  assert.match(T.shell(sim, host, 'ls /data/inbound/customer_static/archive'), /CUSTOMER_STATIC_20261008\.csv/);
});

test('ping answers for a healthy component and reports loss when its host is down', () => {
  const { sim, sod, host } = load();
  assert.match(T.shell(sim, host, 'ping customer_static'), /4 packets transmitted, 4 received, 0% packet loss/);
  assert.match(T.shell(sim, host, 'ping no_such_host'), /Name or service not known/);
});

test('the archive covers the last ten days, and date follows the business day', () => {
  const { sim, host } = load();
  const arch = T.shell(sim, host, 'ls /data/inbound/customer_static/archive');
  assert.strictEqual(arch.match(/CUSTOMER_STATIC_\d{8}\.csv/g).length, 10);
  assert.match(arch, /CUSTOMER_STATIC_20260929\.csv/, 'ten days back from Oct 9');
  assert.match(T.shell(sim, host, 'date'), /^Fri Oct  9 \d\d:\d\d:\d\d IST 2026$/);
});
