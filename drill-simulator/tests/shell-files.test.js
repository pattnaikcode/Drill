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
  const sim = new S.Simulator(bp, { seed: 1, simDay: Date.UTC(2026, 9, 9) }); // pinned so the dates in the assertions hold
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

test('every component keeps ten days of rotated logs, and a day reads hour by hour', () => {
  const { sim, host } = load();
  const listing = T.shell(sim, host, 'ls /var/log/app/archive');
  const hostComps = T.hosts(sim).find(h => h.host === host).comps;
  assert.strictEqual(listing.match(/\.log-\d{8}\.gz/g).length, hostComps.length * 10);
  const day = T.shell(sim, host, `cat /var/log/app/archive/${hostComps[0]}.log-20261008.gz`);
  assert.match(day, /2026-10-08 05:38:05 INFO  \[customer_static\] SOD load: CUSTOMER_STATIC_20261008\.csv loaded, 48,210 records, trailer OK/, 'the day\'s load, as it happened');
  const other = hostComps.find(x => x !== 'customer_static');
  if (other) assert.match(T.shell(sim, host, `cat /var/log/app/archive/${other}.log-20261008.gz`), /2026-10-08 23:00:00 INFO .*hourly summary/, 'a full day of hourly lines');
  assert.match(T.shell(sim, host, `cat /var/log/app/archive/${hostComps[0]}.log-20261101.gz`), /No such file or directory/);
});
