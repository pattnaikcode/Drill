// Run with: node --test tests/*.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const yaml = require('../vendor/js-yaml.min.js');
const S = require('../src/engine.js');
const D = require('../src/session.js');

const dir = p => path.join(__dirname, '..', p);
const bpText = f => fs.readFileSync(dir('blueprints/' + f), 'utf8');
// built-in systems, plus the example systems in examples/ that participants build themselves
const BP_FILES = [...fs.readdirSync(dir('blueprints')).filter(f => f.endsWith('.yaml')).map(f => 'blueprints/' + f), ...fs.readdirSync(dir('examples')).filter(f => f.endsWith('.yaml')).map(f => 'examples/' + f)];
const BLUEPRINTS = Object.fromEntries(BP_FILES.map(f => {
  const r = S.parseBlueprint(fs.readFileSync(dir(f), 'utf8'), yaml);
  if (r.errors.length) throw new Error(f + ': ' + r.errors.join('; '));
  return [r.blueprint.id, r.blueprint];
}));
const drills = fs.readdirSync(dir('drills')).sort().map(f => yaml.load(fs.readFileSync(dir('drills/' + f), 'utf8')));

function run(drill, bp, responder, seed) {
  const sim = new S.Simulator(bp, { seed: 11 });
  const s = new D.Session(sim, drill, { mode: 'assessment', seed: seed || 1 });
  let step = 0;
  while (s.state === 'running' && step < 5000) { s.tick(5); responder(s, step++); }
  return s;
}

// follows the runbook: acknowledge, diagnose, apply each accepted fix in order, clear exception queues
function good(s) {
  if (s.firstAlertAt() !== null && s.ackAt === null) s.acknowledge('Test responder');
  if (s.ackAt !== null && !s.declarations.length && s.sim.t >= s.firstAlertAt() + 120) s.declare(s.sc.root_cause.component, s.sc.root_cause.fault);
  if (!s.declarations.length) return;
  const next = s.sc.accepted_fixes.find(k => !s.actions.some(a => a.key === k));
  if (next) {
    const [c, a] = next.split('.');
    if (a === 'reprocess_rejected' && s.sim.activeFaults().length) return; // fix the data first
    s.requestAction(c, a, 'Approver', true);
  } else if (!s.sim.activeFaults().length) {
    Object.values(s.sim.c).filter(x => x.type === 'service' && x.rejected >= 1).forEach(x => s.requestAction(x.def.id, 'reprocess_rejected', 'Approver', true));
  }
}

// acknowledges late, guesses a wrong cause, and takes the first risky action
function careless(s) {
  if (s.firstAlertAt() !== null && s.sim.t > s.firstAlertAt() + 1500 && s.ackAt === null) {
    s.acknowledge('Test responder');
    const wrong = Object.values(s.sim.c).find(x => x.def.id !== s.sc.root_cause.component);
    s.declare(wrong.def.id, 'bad_deployment', 'guessing');
    const [c, a] = s.sc.risky_actions[0].split('.');
    s.requestAction(c, a, 'Approver', true);
  }
}

test('all blueprints are valid', () => {
  assert.deepStrictEqual(Object.keys(BLUEPRINTS).sort(), ['exchange', 'fraud-aml', 'online-shop', 'trade-allocation-direct', 'trade-allocation-kafka']);
  assert.strictEqual(BLUEPRINTS.exchange.ups.fix_gateway.length, 5, 'five members feed the gateway (fan-in)');
  assert.deepStrictEqual(BLUEPRINTS.exchange.downs.matching.sort(), ['drop_copy', 'md_publisher', 'surv_bus', 'trade_bus'], 'matching feeds four systems (fan-out)');
});

test('blueprint validation catches common mistakes', () => {
  const errs = t => S.parseBlueprint(t, yaml).errors.join('\n');
  const k = bpText('trade-allocation-kafka.yaml');
  assert.match(errs('system: x\ncomponents:\n  - {id: a, type: kafkaa, name: A}\nflow: [a -> b]'), /unknown type "kafkaa"/);
  assert.match(errs(k.replace('trades_topic -> tam', 'trades_tpoic -> tam')), /unknown component "trades_tpoic"/);
  assert.match(errs(k.replace('metric: lag,', 'metric: lagg,')), /no metric "lagg"/);
  assert.match(errs(k.replace('partitions: 6', 'partitions: 0')), /"partitions" is required/);
  assert.match(errs(k.replace('- trades_topic -> tam -> ctm -> settle', '- trades_topic -> tam -> ctm -> settle\n  - settle -> tam')), /loop/);
  assert.match(errs(k.replace('{from: tam, to: ctm,', '{from: oms, to: settle,')), /not connected/);
  assert.match(errs('system: [unclosed'), /YAML syntax/);
});

test('every system is healthy with no alerts when nothing is broken', () => {
  for (const bp of Object.values(BLUEPRINTS)) {
    const sim = new S.Simulator(bp, { seed: 3 });
    for (let i = 0; i < 12 * 75; i++) sim.step(5); // a full drill window: catches reference data that goes stale between loads
    assert.strictEqual(sim.alerts.length, 0, bp.id + ' alerted: ' + sim.alerts.map(a => a.name).join(', '));
    const bad = Object.keys(sim.c).filter(id => sim.health(id) !== 'ok');
    assert.deepStrictEqual(bad, [], bp.id + ' unhealthy: ' + bad.join(', '));
  }
});

test('use cases are offered only on their systems', () => {
  const stuck = drills.find(d => d.id === 'stuck-partition');
  assert.strictEqual(D.drillFor(stuck, BLUEPRINTS['trade-allocation-direct']), false);
  assert.strictEqual(D.drillFor(stuck, BLUEPRINTS.exchange), false);
  assert.match(D.validateDrill(stuck, BLUEPRINTS['trade-allocation-direct']).join(), /trades_topic/);
  const exch = drills.filter(d => D.drillFor(d, BLUEPRINTS.exchange)).length;
  assert.strictEqual(exch, 11);
});

for (const drill of drills) {
  for (const sysId of drill.systems) {
    const bp = BLUEPRINTS[sysId];
    test(`"${drill.id}" is valid on ${sysId}`, () => assert.deepStrictEqual(D.validateDrill(drill, bp), []));
    const seeds = drill.mystery ? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] : [1];
    for (const seed of seeds) {
      test(`"${drill.id}" on ${sysId}${drill.mystery ? ' seed ' + seed : ''}: runbook responder recovers before cut-off`, () => {
        const s = run(drill, bp, good, seed);
        const sc = s.score();
        assert.strictEqual(s.endReason, 'recovered', `ended with ${s.endReason}; ${JSON.stringify(sc.parts)}`);
        assert.ok(sc.total >= 85, `score ${sc.total}: ${JSON.stringify(sc.parts)}`);
      });
    }
    test(`"${drill.id}" on ${sysId}: careless responder scores low`, () => {
      const s = run(drill, bp, careless, 3);
      assert.ok(s.score().total < 50, `score ${s.score().total}: ${JSON.stringify(s.score().parts)}`);
    });
  }
}

test('restarting the gateway does not fix a member sequence mismatch, and disconnects everyone', () => {
  const sim = new S.Simulator(BLUEPRINTS.exchange, { seed: 5 });
  sim.injectFault('broker_b', 'session_down');
  for (let i = 0; i < 24; i++) sim.step(5);
  const r = sim.applyAction('fix_gateway', 'restart');
  assert.match(r.message, /All 5 participant sessions were disconnected/);
  for (let i = 0; i < 24; i++) sim.step(5);
  assert.strictEqual(sim.metric('fix_gateway', 'sessions_down'), 1);
  assert.ok(sim.c.broker_b.held > 100);
});

test('a missed corporate action rejects orders in one symbol, and rejects go back to the member', () => {
  const sim = new S.Simulator(BLUEPRINTS.exchange, { seed: 5 });
  sim.injectFault('issuer_2', 'announcement_missed');
  for (let i = 0; i < 60; i++) sim.step(5);
  assert.ok(sim.metric('risk', 'reject_rate') > 4);
  assert.strictEqual(sim.c.risk.rejected, 0, 'returned rejects are not held for reprocessing');
  assert.ok(sim.c.risk.logs.some(l => /KONSTL/.test(l.msg)));
  assert.strictEqual(sim.health('issuer_2'), 'ok', 'the exchange cannot see inside an issuer');
});

test('restarting the consumer does not clear a poison message', () => {
  const sim = new S.Simulator(BLUEPRINTS['trade-allocation-kafka'], { seed: 5 });
  sim.injectFault('trades_topic', 'poison_message', { partition: 2 });
  for (let i = 0; i < 60; i++) sim.step(5);
  sim.applyAction('tam', 'restart');
  for (let i = 0; i < 60; i++) sim.step(5);
  assert.ok(sim.metric('trades_topic', 'max_partition_lag') > 200);
  assert.strictEqual(sim.activeFaults().length, 1);
});

test('actions need a named approver and confirmation', () => {
  const sim = new S.Simulator(BLUEPRINTS['trade-allocation-kafka'], { seed: 5 });
  const s = new D.Session(sim, drills.find(d => d.id === 'allocations-falling-behind'), {});
  assert.strictEqual(s.requestAction('tam', 'scale_out', '', true).ok, false);
  assert.strictEqual(s.requestAction('tam', 'scale_out', 'Rahul', false).ok, false);
  assert.strictEqual(s.actions.length, 0);
});

// ---------------------------------------------------------------- investigation tools
const T = require('../src/tools.js');
test('tools: SQL console is read-only and finds the blocking session', () => {
  const sim = new S.Simulator(BLUEPRINTS.exchange, { seed: 5 });
  sim.injectFault('orderbook_db', 'pool_exhausted');
  for (let i = 0; i < 24; i++) sim.step(5);
  for (const bad of ["DELETE FROM sessions", "update sessions set status='X'", "ALTER SYSTEM KILL SESSION '482,1'", 'drop table rejects'])
    assert.match(T.sql(sim, 'orderbook_db', bad).error, /read-only/);
  const r = T.sql(sim, 'orderbook_db', 'SELECT sid, program, connections_held FROM v$session ORDER BY connections_held DESC LIMIT 1');
  assert.deepStrictEqual(r.rows[0], [482, 'month_end_recon_report', 76]);
  assert.match(T.sql(sim, 'orderbook_db', 'SELECT nope FROM sessions').error, /invalid identifier/);
});
test('tools: Splunk-style search groups errors and normalises patterns', () => {
  const sim = new S.Simulator(BLUEPRINTS.exchange, { seed: 5 });
  sim.injectFault('issuer_2', 'announcement_missed');
  for (let i = 0; i < 60; i++) sim.step(5);
  const r = T.search(sim, 'level=ERROR | stats count by component');
  assert.strictEqual(r.table.rows[0][0], 'risk');
  const top = T.search(sim, 'component=risk level=ERROR | top pattern');
  assert.match(top.table.rows[0][0], /outside band for KONSTL/);
  assert.ok(T.search(sim, '* | frobnicate').error);
});
test('tools: Unix shell is read-only and shows the real state', () => {
  const sim = new S.Simulator(BLUEPRINTS['trade-allocation-kafka'], { seed: 5 });
  sim.injectFault('tam', 'instances_lost');
  for (let i = 0; i < 24; i++) sim.step(5);
  for (const bad of ['rm -rf /var/log', 'kill -9 3120', 'sudo reboot', 'systemctl restart tam', 'kubectl delete pod tam-7f9c-3'])
    assert.match(T.shell(sim, 'tam-node1', bad), /Permission denied/);
  assert.strictEqual((T.shell(sim, 'tam-node1', 'kubectl get pods | grep Pending | wc -l')), '2');
  assert.match(T.shell(sim, 'tam-node1', 'kubectl describe pod tam-7f9c-4'), /Insufficient memory/);
  assert.match(T.shell(sim, 'nowhere', 'ls'), /Could not resolve/);
});

// ---------------------------------------------------------------- nested (host) and API faults
test('a full archive disk on the database stalls matching; killing sessions does not help', () => {
  const sim = new S.Simulator(BLUEPRINTS.exchange, { seed: 5 });
  sim.injectFault('orderbook_db', 'disk_full');
  for (let i = 0; i < 36; i++) sim.step(5);
  assert.ok(sim.metric('matching', 'out_rate') < 100);
  assert.match(T.shell(sim, 'orderbook-db-db1', 'df -h'), /100% \/u01\/arch/);
  assert.match(T.search(sim, 'component=matching level=ERROR').events[0].msg, /ORA-00257/);
  assert.match(sim.applyAction('orderbook_db', 'kill_blocking_session').message, /archiving needed/);
  assert.strictEqual(sim.applyAction('orderbook_db', 'clear_disk_space').effect, 'fixed');
  assert.strictEqual(sim.activeFaults().length, 0);
});
test('gateway clock drift disconnects every member; sequence resets do not help', () => {
  const sim = new S.Simulator(BLUEPRINTS.exchange, { seed: 5 });
  sim.injectFault('fix_gateway', 'clock_skew');
  for (let i = 0; i < 24; i++) sim.step(5);
  assert.strictEqual(sim.metric('fix_gateway', 'sessions_down'), 5);
  assert.match(sim.applyAction('broker_a', 'reset_sequence').message, /SendingTime/);
  assert.match(T.shell(sim, 'fix-gateway-node1', 'chronyc tracking'), /Not synchronised/);
  assert.ok(T.sql(sim, 'orderbook_db', "SELECT * FROM sessions WHERE last_reject_reason = 'SendingTime accuracy problem'").rows.length === 5);
});
test('API faults: 429 and 401 show in logs and health, and restarts do not fix them', () => {
  const sim = new S.Simulator(BLUEPRINTS['trade-allocation-kafka'], { seed: 5 });
  sim.injectFault('ctm', 'api_rate_limited');
  for (let i = 0; i < 36; i++) sim.step(5);
  assert.ok(sim.c.ctm.logs.some(l => /429 Too Many Requests/.test(l.msg)));
  assert.match(T.shell(sim, 'ctm-adapter', 'cat /etc/app/application.yml'), /retry-policy: immediate/);
  sim.applyAction('ctm', 'restart_adapter');
  assert.strictEqual(sim.activeFaults().filter(f => f.type === 'api_rate_limited').length, 1);
  assert.strictEqual(sim.applyAction('ctm', 'enable_retry_backoff').effect, 'fixed');
  sim.injectFault('ctm', 'api_auth_expired');
  for (let i = 0; i < 24; i++) sim.step(5);
  assert.match(T.shell(sim, 'ctm-adapter', 'curl -s localhost:8080/health'), /401 Unauthorized/);
  assert.match(sim.applyAction('ctm', 'escalate_to_vendor').message, /client secret expired/);
});
test('memory crash loop is visible in kubectl and not fixed by a restart', () => {
  const sim = new S.Simulator(BLUEPRINTS['trade-allocation-kafka'], { seed: 5 });
  sim.injectFault('tam', 'memory_oom');
  for (let i = 0; i < 80; i++) sim.step(5);
  assert.match(T.shell(sim, 'tam-node1', 'kubectl describe pod tam-7f9c-1'), /OOMKilled/);
  sim.applyAction('tam', 'restart');
  assert.strictEqual(sim.hostFault(sim.c.tam), 'memory_oom');
});
test('the root-cause list is the same for every component and includes decoys', () => {
  const keys = S.CAUSES.map(c => c.key);
  for (const t of Object.keys(S.TYPES)) for (const f of Object.keys(S.faultsFor(t))) assert.ok(keys.includes(f), f + ' missing from CAUSES');
  assert.ok(keys.includes('market_volume') && keys.includes('api_schema_change'));
});

// ---------------------------------------------------------------- partition assignment and shared servers (generic)
test('consumers with their own partitions: a hot key overloads one server, rebalancing spreads it', () => {
  const text = `
id: partitioned
system: Partitioned consumers
clock: {start: "10:00", cutoff: "11:00"}
business: {kpis: [{label: Not processed, at: proc_1, cutoff: true}]}
components:
  - {id: feed, type: source, name: Feed, rate_per_min: 2000}
  - {id: topic, type: kafka_topic, name: events, partitions: 4, keys: [A, B, C, D], weights: [0.4, 0.2, 0.2, 0.2],
     assign: {cons_1: [0, 1], cons_2: [2, 3]}}
  - {id: cons_1, type: service, name: Consumer 1, host: srv-01, mount: /data/app, capacity_per_min: 1300, instances: 1}
  - {id: proc_1, type: service, name: Processor 1, host: srv-01, mount: /data/app, capacity_per_min: 3000, instances: 1}
  - {id: cons_2, type: service, name: Consumer 2, host: srv-02, capacity_per_min: 1500, instances: 1}
flow:
  - feed -> topic
  - topic -> cons_1 -> proc_1
  - topic -> cons_2`;
  const r = S.parseBlueprint(text, yaml);
  assert.deepStrictEqual(r.errors, []);
  const sim = new S.Simulator(r.blueprint, { seed: 2 });
  sim.injectFault('topic', 'partition_skew', { partition: 0, multiplier: 3 });
  for (let i = 0; i < 120; i++) sim.step(5);
  assert.ok(sim.metric('cons_1', 'consumer_lag') > 1000 && sim.metric('cons_2', 'consumer_lag') < 50, 'only the server owning the hot partition lags');
  assert.match(T.shell(sim, 'srv-01', 'cat /opt/app/conf/partitions.conf'), /cons_1.partitions=0,1/);
  assert.strictEqual(sim.applyAction('topic', 'rebalance_partitions').effect, 'fixed');
  sim.injectFault('proc_1', 'disk_full');
  assert.strictEqual(sim.hostFault(sim.c.cons_1), 'disk_full', 'processes on one server share its disk');
  assert.match(T.shell(sim, 'srv-01', 'df -h'), /100% \/data\/app/);
});
