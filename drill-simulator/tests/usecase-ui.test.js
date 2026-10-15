// Runs the Use Case Builder's page logic against a minimal stand-in for the page: no browser needed.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const yaml = require('../vendor/js-yaml.min.js');

const dir = p => path.join(__dirname, '..', p);
const read = p => fs.readFileSync(dir(p), 'utf8');
const all = d => Object.fromEntries(fs.readdirSync(dir(d)).filter(f => f.endsWith('.yaml')).map(f => [f.replace(/\.yaml$/, ''), read(d + '/' + f)]));

function page() {
  const handlers = { change: [], click: [] };
  const app = {
    innerHTML: '',
    children: [],
    addEventListener(type, fn) { handlers[type].push(fn); },
    fire(type, target) { handlers[type].forEach(fn => fn({ target, })); },
  };
  const elements = { app };
  const sandbox = {
    console, setTimeout, navigator: {},
    document: { getElementById: id => elements[id] || null },
  };
  sandbox.window = sandbox;
  sandbox.DRILL_CONTENT = {
    blueprints: { ...all('blueprints'), ...all('examples') },
    packs: Object.values(all('packs')),
    drills: Object.values(all('drills')),
    default_blueprint: 'web-shop-generic',
  };
  vm.createContext(sandbox);
  ['vendor/js-yaml.min.js', 'src/engine.js', 'src/session.js', 'src/usecase.js', 'src/usecase-ui.js'].forEach(f => {
    vm.runInContext(read(f), sandbox, { filename: f });
  });
  // the page keeps the inlined js-yaml as window.jsyaml
  return { app, sandbox, handlers };
}

// a stand-in for an element that the page reads from event targets
const el = (dataset, extra = {}) => ({ dataset, ...extra, closest() { return this; } });

test('the page loads, offers the example systems and says what is missing', () => {
  const { app, sandbox } = page();
  assert.ok(app.innerHTML.includes('Add at least one fault'), 'starts unready');
  assert.ok(app.innerHTML.includes('Web shop'), 'the example system is offered');
  assert.ok(app.innerHTML.includes('drills/'), 'shows where to save the file');
  assert.ok(sandbox.OpsUseCase && sandbox.OpsDrill, 'logic modules are available');
});

test('adding a fault, a root cause and a fix turns the page ready and writes the YAML', () => {
  const { app, handlers } = page();
  // add a fault: the page offers a component and one of its faults
  handlers.click.forEach(fn => fn({ target: el({ act: 'addFault' }) }));
  assert.ok(app.innerHTML.includes('Remove'), 'the fault row appears');
  // a user picks the topic, then one of the topic's faults
  handlers.change.forEach(fn => fn({ target: el({ fcomp: '0' }, { value: 'order_events' }) }));
  handlers.change.forEach(fn => fn({ target: el({ fkey: '0' }, { value: 'poison_message' }) }));
  // root cause and an accepted fix, chosen by the same keys the page offers
  const rootKey = 'order_events|poison_message';
  handlers.change.forEach(fn => fn({ target: el({ f: 'root' }, { value: rootKey }) }));
  handlers.change.forEach(fn => fn({ target: el({ acc: 'order_events.skip_poison_message' }, { checked: true }) }));
  assert.ok(app.innerHTML.includes('Ready: this use case can be run and scored.'), 'the check passes');
  const yamlText = app.innerHTML.match(/<pre id="yamlOut">([\s\S]*?)<\/pre>/)[1]
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  const o = yaml.load(yamlText);
  assert.strictEqual(o.root_cause.component, 'order_events');
  assert.deepStrictEqual(o.accepted_fixes, ['order_events.skip_poison_message']);
  assert.strictEqual(o.faults.length, 1);
  assert.deepStrictEqual(o.systems, ['web-shop-generic']);
});

test('removing the only fault makes the page unready again', () => {
  const { app, handlers } = page();
  handlers.click.forEach(fn => fn({ target: el({ act: 'addFault' }) }));
  handlers.click.forEach(fn => fn({ target: el({ act: 'rmFault', i: '0' }) }));
  assert.ok(app.innerHTML.includes('No faults yet'));
  assert.ok(app.innerHTML.includes('Add at least one fault'));
});
