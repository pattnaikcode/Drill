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

**How it behaves.**
- Speed: 0.5×, 1× (default), 2× or 4×. At 1× one real second is ten simulated seconds.
- Acknowledge is available only after the first real alert fires. Before that the Respond panel says
  "Waiting for the first alert". The session refuses an earlier acknowledgement too.
- The alert list shows up to about 60% of the window height and scrolls; the newest alerts are at the top.
- Components and actions in the request dropdowns are grouped (by kind, and fixes before other actions).
- After a fault clears, the orders queued during the outage must drain before the cut-off. The example
  systems have spare capacity after the failure point, set in their YAML (`capacity_per_min`). Raising it shortens the drain.

**Where to start when it misbehaves.**
- A drill does not start: check the system's blueprint loads (`src/engine.js` `validateBlueprint`).
- Charts look wrong: check `src/tools.js` and the metric history in `src/engine.js` (`_sample`).
- Scoring looks wrong: `src/session.js`, which compares declared root causes and fixes to the drill file.
- A drill cannot be recovered in time: check the backlog at the cut-off (`cutoffKpi` in `src/engine.js`) and
  the capacity of the stages upstream of the cut-off in the system's YAML.

**Limits.** No fault injection (that is the admin page). Drill content is read from `drills/*.yaml` when the
app is built, so a new or changed drill appears after `python3 build.py`.

---

## 2. OpsPilot Admin (instructor page)

**Purpose.** For a trainer: pick a system and a use case, inject faults at chosen times, and see the answers
live as the room works.

**Source.** `src/index.template.html` built with the admin flag (`build.py`), output `dist/admin.html`.

**Where to start.** Fault injection goes through `Simulator.injectFault` in `src/engine.js`.

**Limits.** Use cases are YAML files on disk. Build them in the Use Case Builder (section 3b) rather than by hand.

---

## 3. System Builder (forms that write blueprint YAML)

**Purpose.** Create or change a system from forms: components, flow, alerts and KPIs, without typing YAML.

**Source.** `src/builder.js`, `src/builder.template.html`. Output `dist/builder.html`.

**Where to start.** The YAML is produced by `src/builder.js`; the validator is `src/engine.js`.

**Limits.** Tables and journeys are not in this builder yet. Use the Designer (section 4) for them.

---

## 3b. Use Case Builder (forms that write drill YAML)

**Purpose.** Write one use case (a drill) from forms: the system, title, level and brief; faults with their time,
component, fault and parameters; hints; the debrief; the root cause, accepted fixes and risky actions. The YAML
on the right is rewritten on every change, and the page checks the use case with the drill player's own rules.

**Source.** `src/usecase.js` (the logic), `src/usecase-ui.js` (the form), `src/usecase.template.html`. Output
`dist/usecase.html`. The save route is in `src/api.js` (`POST /api/drills`).

**Saving.** "Save to drills folder" posts the YAML to the simulator server on this machine (default port 3000).
Start it with `node src/server.js --blueprint <system file>`. The server checks the use case against that
system, refuses to overwrite an existing drill unless you confirm, and writes `drills/<id>.yaml`. It accepts
requests from this machine only. Run `python3 build.py` afterwards so the drill player shows it.

**Where to start when it misbehaves.**
- A fault or fix is missing from a list: `faultChoices` and `actionChoices` in `src/usecase.js`.
- "Save" says it cannot reach the server: the server is not running on that port, or it runs a different system.
- The check says the root cause is not one of the faults: it must match a fault row exactly (component and fault).

**Limits.** No tables or journeys (those belong to the system, not the drill). Saving an existing use case
replaces its file after you confirm. Saving needs the simulator server running on the same machine.

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
- Tables and journeys are added in the System panel (not on the canvas). A journey's steps are one per line,
  with an optional `| table: insert col=value` write. The check reports any step that does not fit the flow.
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

1. Use cases appear in the drill player only after a rebuild; there is no live reload.
2. The Designer's tables and journeys have no drag-and-drop on the canvas.
3. Designer work saved to a server so it can be shared.
4. Alerts with a duration and combined conditions.
5. Real per-request traces in the API.
6. Errors shown on the box that causes them.
7. Exchange drills tolerate a responder about 5 minutes slower than the debrief pace, and four drills were removed for missing that margin (see the git history of `drills/`).
