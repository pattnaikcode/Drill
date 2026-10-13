#!/usr/bin/env node

/**
 * OpsPilot Simulator Server
 *
 * Runs a drill with the HTTP API exposed.
 * Usage:
 *   node src/server.js --blueprint examples/bank-cards-upi.yaml --port 3000
 */

const fs = require('fs');
const path = require('path');
const yaml = require('../vendor/js-yaml.min.js');
const S = require('./engine.js');
const SimulatorAPI = require('./api.js');

// Parse command-line arguments
const args = process.argv.slice(2);
let blueprintFile = null;
let port = 3000;
let speed = 1; // simulation steps per tick

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--blueprint' && i + 1 < args.length) {
    blueprintFile = args[++i];
  } else if (args[i] === '--port' && i + 1 < args.length) {
    port = parseInt(args[++i], 10);
  } else if (args[i] === '--speed' && i + 1 < args.length) {
    speed = parseInt(args[++i], 10);
  }
}

if (!blueprintFile) {
  console.error('Usage: node src/server.js --blueprint <file> [--port 3000] [--speed 1]');
  process.exit(1);
}

// Load blueprint
let blueprintPath = path.resolve(blueprintFile);
// Try relative to drill-simulator directory if file not found
if (!fs.existsSync(blueprintPath)) {
  blueprintPath = path.resolve(__dirname, '..', blueprintFile);
}

if (!fs.existsSync(blueprintPath)) {
  console.error(`Blueprint not found: ${blueprintFile}`);
  process.exit(1);
}

// Load and register all packs
console.log('Loading packs...');
const packDir = path.resolve(__dirname, '..', 'packs');
if (fs.existsSync(packDir)) {
  fs.readdirSync(packDir).forEach(file => {
    if (file.endsWith('.yaml')) {
      const packText = fs.readFileSync(path.join(packDir, file), 'utf8');
      const packData = yaml.load(packText);
      const errors = S.registerPack(packData);
      if (errors.length) {
        console.warn(`Warning loading pack ${file}:`, errors);
      } else {
        console.log(`  ✓ Loaded pack: ${packData.pack}`);
      }
    }
  });
}

console.log(`Loading blueprint from: ${blueprintPath}`);
const blueprintText = fs.readFileSync(blueprintPath, 'utf8');
const result = S.validateBlueprint(yaml.load(blueprintText));

if (result.errors && result.errors.length) {
  console.error('Blueprint validation errors:');
  result.errors.forEach(e => console.error(`  - ${e}`));
  process.exit(1);
}

const blueprint = result.blueprint;
console.log(`System: ${blueprint.system}`);
console.log(`Components: ${blueprint.components.length}`);

// Create simulator
const sim = new S.Simulator(blueprint, { seed: 42 });

// Create API
const api = new SimulatorAPI(sim);

// Start HTTP server
const server = api.listen(port);

console.log(`Simulator API started at http://localhost:${port}`);
console.log(`\nEndpoints:`);
console.log(`  POST /api/v1/metrics  - Query time-series metrics`);
console.log(`  POST /api/v1/events   - Search logs`);
console.log(`  POST /api/v1/traces   - Query request flows`);
console.log(`  POST /api/v1/sql      - Run SQL queries`);
console.log(`  POST /api/v1/health   - Health check`);

// Simulation loop: run steps and update metrics
const runSimulation = () => {
  // Step the simulator
  for (let i = 0; i < speed; i++) {
    sim.step(5); // 5-second steps
  }

  // Re-run every 100ms (accelerates the simulation)
  setTimeout(runSimulation, 100);
};

console.log(`\nSimulation starting at ${sim.time()}, speed ${speed}x`);
runSimulation();

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  server.close();
  process.exit(0);
});
