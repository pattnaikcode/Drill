// The Unix tool's server names must say which components run on them, so people can connect the
// diagram to the shell.
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
const load = file => {
  const r = S.validateBlueprint(yaml.load(fs.readFileSync(dir(file), 'utf8')));
  assert.deepStrictEqual(r.errors, [], file);
  return new S.Simulator(r.blueprint, { seed: 1 });
};

test('a component reports the server the Unix tool names it by', () => {
  const sim = load('blueprints/trade-allocation-kafka.yaml');
  assert.strictEqual(T.hostOf(sim, 'tam'), 'tam-node1');
  assert.strictEqual(T.hostOf(sim, 'nope'), '');
});

test('the Host list names the components and their unit names on each server', () => {
  const sim = load('blueprints/trade-allocation-kafka.yaml');
  const h = T.hosts(sim).find(x => x.host === 'tam-node1');
  const label = T.hostLabel(sim, h);
  assert.match(label, /^tam-node1 — /);
  assert.match(label, /Allocation Engine \(unit tam\.service\)/);
});

test('all Kafka topics on the shared broker are listed, not only the first', () => {
  const bp = {
    id: 'two-topics', system: 'Two topics', clock: { start: '09:00', cutoff: '10:00' },
    components: [
      { id: 'src_a', type: 'source', name: 'Source A', rate_per_min: 100 },
      { id: 'topic_a', type: 'kafka_topic', name: 'Topic A', partitions: 2 },
      { id: 'svc_a', type: 'service', name: 'Service A', capacity_per_min: 500, instances: 1 },
      { id: 'src_b', type: 'source', name: 'Source B', rate_per_min: 100 },
      { id: 'topic_b', type: 'kafka_topic', name: 'Topic B', partitions: 2 },
      { id: 'svc_b', type: 'service', name: 'Service B', capacity_per_min: 500, instances: 1 },
    ],
    flow: ['src_a -> topic_a -> svc_a', 'src_b -> topic_b -> svc_b'],
  };
  const r = S.validateBlueprint(bp);
  assert.deepStrictEqual(r.errors, []);
  const sim = new S.Simulator(r.blueprint, { seed: 1 });
  const broker = T.hosts(sim).find(x => x.host === 'kafka-broker1');
  assert.deepStrictEqual(broker.comps.sort(), ['topic_a', 'topic_b']);
  assert.strictEqual(T.hostOf(sim, 'topic_b'), 'kafka-broker1');
});
