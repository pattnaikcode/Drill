# OpsPilot applications: what each one does

Read this first when you pick up the project or start debugging. Each section says what the application
is for, how it fits with the others, where to start when something is wrong, and what it cannot do yet.

Everything under `drill-simulator/` is built with `python3 build.py` into single HTML files in `dist/`,
and tested with `node --test tests/*.test.js`.

---

## 1. OpsPilot Drills (participant page)

**Purpose.** Run an incident drill: a simulated production system breaks, you investigate with Grafana-style
charts, Splunk-style search, a read-only SQL console and safe Unix commands, then apply fixes and get scored.

**Users.** Production support people practising, and trainers running sessions.

**Source.** `src/index.template.html`, `src/app.js`, `src/tools.js`, `src/session.js`, `src/trace.js`.
Built to `dist/index.html`.

**Where to start when it misbehaves.**
- A drill does not start: check the system's blueprint loads (`src/engine.js` `validateBlueprint`).
- Charts look wrong: check `src/tools.js` and the metric history in `src/engine.js` (`_sample`).
- Scoring looks wrong: `src/session.js`, which compares declared root causes and fixes to the drill file.

**Limits.** No fault injection (that is the admin page). Drill content is read from `drills/*.yaml`; there is
no editor for it yet.

---

## 2. OpsPilot Admin (instructor page)

**Purpose.** For a trainer: pick a system and a use case, inject faults at chosen times, and see the answers
live as the room works.

**Source.** `src/index.template.html` built with the admin flag (`build.py`), output `dist/admin.html`.

**Where to start.** Fault injection goes through `Simulator.injectFault` in `src/engine.js`.

**Limits.** Use cases are YAML files, not forms. Editing a use case means editing `drills/*.yaml`.

---

## 3. System Builder (forms that write blueprint YAML)

**Purpose.** Create or change a system from forms: components, flow, alerts and KPIs, without typing YAML.

**Source.** `src/builder.js`, `src/builder.template.html`. Output `dist/builder.html`.

**Where to start.** The YAML is produced by `src/builder.js`; the validator is `src/engine.js`.

**Limits.** It is a form editor, so it has the same gaps as the Designer for tables and journeys.

---

## 4. Designer (drag and drop)

**Purpose.** Draw a system on a canvas: drag boxes from the palette, connect them with flow lines, group them,
and set their properties. The YAML view updates as you work.

**Users.** Anyone designing a system before it is used in a drill.

**Source.** `src/designer.js`, `src/designer.template.html`. Output `dist/designer.html`.

**Where to start when it misbehaves.**
- A box will not appear: check the palette in `renderPalette` (`src/designer.js`). Sector packs appear under
  their own names, and packs marked `open: true` start expanded.
- A change is refused: the message comes from `validateBlueprint` in `src/engine.js`. Read the message; it names
  the component and the rule.
- Work is lost on reload: work is saved in the browser's local storage only.

**Limits.**
- Tables and journeys can only be edited as YAML.
- Alerts take one threshold (above or below). There is no duration or combined condition.
- Saving is per browser. Nothing is shared between people or machines.
- Some settings have no form field: pack-specific fields, host settings such as `mount`, and Kafka `weights`,
  `assign` and `keys`.
- Errors are listed at the bottom, not on the box that caused them.

---

## 5. Observability API and simulator server (command line)

**Purpose.** Expose a running simulation over HTTP, so charts, search, SQL and tickets can query it the way they
would query real monitoring systems. Used to test the copilot idea before it touches real systems.

**Source.** `src/api.js` (query engines), `src/server.js` (starts a simulation and the API).

**Run.** `node src/server.js --blueprint examples/web-shop-generic.yaml --port 3000`

**Endpoints.** `POST /api/v1/metrics`, `/events`, `/traces`, `/sql`, `/health`.

**Where to start when it misbehaves.**
- Metric points are wrong: the timestamps come from `sim.history.t`, which is set in `_sample` in `src/engine.js`.
  Tests in `tests/api.test.js` cover this.
- An endpoint returns an error about a missing name: the component or metric id does not exist in the blueprint.

**Limits.**
- `/traces` returns a component's details and neighbours, not real per-request traces.
- `/sql` understands three queries only: components, events and alerts.
- One blueprint per server, in memory, with no login.

---

## 6. Operations Command Center

**Purpose.** A single screen for the on-call view of a system: status of each component and open alerts.

**Source.** `command-center/index.html` (a single file).

**Limits.** Not yet connected to the simulator API; it shows its own sample state.

---

## 7. OpsPilot Lab (real Linux)

**Purpose.** A disposable Linux machine in Docker with a small "orders" application that can be broken for real,
and an investigation runner that uses only approved, read-only checks.

**Source.** `linux-lab/` (see `linux-lab/README.md` for how to start it, which needs Docker).

**Where to start.** `linux-lab/README.md`, then the runner in `linux-lab/app`.

---

## 8. Landing page

**Purpose.** The public front page for the project.

**Source.** `index.html` at the repository root.

---

## Known gaps, in the order they should be closed

1. Tables and journeys editable in the Designer (currently YAML only).
2. Drills (use cases and faults) editable in a form, instead of YAML files.
3. Designer work saved to a server so it can be shared.
4. Alerts with a duration and combined conditions.
5. Real per-request traces in the API.
6. Errors shown on the box that causes them.
