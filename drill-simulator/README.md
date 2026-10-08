# OpsPilot Drill Simulator

A browser-based incident drill simulator for production support teams. **Design a system, add use cases to it, and run them as scored drills**, investigating with Grafana-, Splunk-, SQL- and Unix-style tools.

Open `dist/index.html` in any modern browser. No server, no install.

## Built-in systems

| System | Architecture | Use cases |
|---|---|---|
| **Equity exchange trading platform** | 3 brokers and 2 market makers over FIX → gateway → pre-trade risk (instrument master kept current by 3 listed issuers) → matching (order book store) → Kafka trade bus → clearing corporation; matching also feeds market data vendors and drop copy | Broker cannot log in · Market maker floods the gateway · Orders rejected in one stock (missed corporate action) · Matching slows to a crawl · Trades not reaching clearing · Some trades never reach clearing (stuck partition) · Mystery |
| **Middle-office trade allocation** (with Kafka) | OMS and execution desk → Kafka → allocation engine (SSI reference data, allocation DB) → confirmation platform → settlement | Allocations falling behind · One partition stuck · Missing settlement instructions · Confirmations not matching · Allocation engine choking · Mystery |
| **Middle-office trade allocation** (direct) | Same system without Kafka, to compare designs | All of the above except the stuck partition |

Every system has a **flow diagram** with groups (who owns what) and numbered steps describing the business flow. Participants see it before they start and can open it at any time during a drill.

## How a drill works

1. Choose a system and read its flow diagram.
2. Choose a use case. Faults are injected at the scheduled time without telling you what or where.
3. Investigate with the live map, component inspector and four tools (below).
4. Acknowledge, declare the root cause, and request fixes. Every change needs a named approver and confirmation.
5. The drill ends when business flow is back to normal or the deadline passes. You get a score and a debrief: timeline, time to detect / acknowledge / diagnose / recover, every tool query you ran, the signal to spot, why the obvious fix is wrong, and the runbook.

## Investigation tools

All tools read the live simulation, so what you find depends on what is actually broken. All are read-only.

| Tool | What it does | Try |
|---|---|---|
| **Grafana** | Time-series panels for every component, with alert thresholds | Overview dashboard, or one component's dashboard |
| **Splunk** | Search every component's logs. Fields `component=` `level=` `earliest=-15m`, `"phrases"`, `NOT`. Commands `stats count by component|level|pattern`, `top pattern` (groups lines that differ only by IDs and numbers), `timechart count`, `head` | `level=ERROR \| stats count by component` |
| **Database** | SQL console on each database: `v$session`, `sessions` (FIX sessions and sequence numbers), `rejects`, `corporate_actions`, `instruments`, reference data load logs. `SELECT … WHERE … GROUP BY … ORDER BY … LIMIT`, `SHOW TABLES`, `DESCRIBE`. Anything that changes data is refused. | `SELECT * FROM sessions` |
| **Unix** | Shell on each host the support team owns: `tail`, `grep`, `ps`, `free`, `kubectl get/describe pods`, `kafka-consumer-groups.sh --describe`, `curl` health, `cat` config, with pipes to `grep`, `tail`, `head`, `wc -l`, `sort`. `rm`, `kill`, `sudo`, restarts and other changes are refused. | `kubectl get pods \| grep Pending` |

Participants' and vendors' own servers are deliberately not reachable, just as in real life.

## Design your own

The **Design** tab has two editors:

1. **System**: write or edit a blueprint, check it, and save. It appears as a new system on the Drills tab.
2. **Use case**: write a drill for the loaded system, starting from a template or a copy of an existing one. It appears under that system.

A reference table lists every component of the loaded system with the faults it can have and the actions that fix them, so you can write use cases without reading code. Designs are saved in the browser; to keep them in the project, copy the YAML into `blueprints/` or `drills/` and run `python3 build.py`.

## How it works

Three layers keep it configurable:

| Layer | Where | Changes when |
|---|---|---|
| **Component types**: how a kind of thing behaves, what it measures, how it fails and how it is fixed | `src/engine.js` (`TYPES`) | You need a new kind of building block (rare) |
| **System blueprint**: components, flow, alert rules, flow diagram | `blueprints/*.yaml` | You model a new system |
| **Use case (drill)**: fault and timing, correct answer, scoring, debrief | `drills/*.yaml` | You write a new exercise |

The flow is a graph: many members can feed one gateway, and one matching engine can feed clearing, market data and drop copy at once. Every simulated 5 seconds, work moves through the graph in dependency order; each component takes what its capacity allows and passes it on. A fault only changes one component's rules (a member's session rejected, a flood of messages, a missed corporate action, a blocked partition, an exhausted connection pool, an unavailable vendor). Queues, lag, rejects, alerts and the deadline projection all follow from the flow, nothing is scripted.

### Component types

| Type | Required | Metrics (for alert rules) | Faults | Fix actions |
|---|---|---|---|---|
| `source` (participant) | `rate_per_min` (+ `role`, `session`) | `out_rate`, `held` | `session_down`, `order_flood` | `reset_sequence`, `apply_throttle` |
| `kafka_topic` | `partitions` (+ `consumer_group`) | `lag`, `max_partition_lag`, `in_rate`, `out_rate`, `rebalances` | `poison_message`, `rebalance_storm` | `skip_poison_message`, `tune_consumer_timeout` |
| `service` | `capacity_per_min` (+ `instances`, `uses`, `rejects: queue\|return`) | `in_rate`, `out_rate`, `backlog`, `reject_rate`, `error_rate`, `instances`, `latency_ms`, `rejected`, `sessions_down` | `instances_lost` | `scale_out`, `restart`, `reprocess_rejected` |
| `external_party` | `capacity_per_min` | `in_rate`, `out_rate`, `backlog`, `error_rate` | `unavailable` | `escalate_to_vendor`, `restart_adapter` |
| `ref_data` | `refresh_every_min`, `stale_after_min` | `staleness_min` | `feed_failed` | `force_refresh` |
| `database` | `pool_size` | `pool_used`, `pool_pct`, `wait_ms` | `pool_exhausted` | `kill_blocking_session` |
| `issuer` | `feeds` (a `ref_data` id) (+ `symbol`) | `pending_announcements` | `announcement_missed` | `reload_announcement` |

### Blueprint format (excerpt)

```yaml
id: exchange
system: Equity exchange trading platform
clock: {start: "14:30", cutoff: "15:30", cutoff_label: Clearing cut-off}
business:
  unit_name: orders
  avg_notional: 0.04
  kpis:
    - {label: "Orders waiting to match", at: matching}
    - {label: "Trades not with clearing", at: clearing, cutoff: true}
components:
  - {id: broker_a, type: source, role: Broker, name: Kestrel Securities, session: KEST01, rate_per_min: 420}
  - {id: fix_gateway, type: service, name: FIX Order Gateway, capacity_per_min: 2700, instances: 3}
  - {id: risk, type: service, name: Pre-trade Risk Checks, capacity_per_min: 2800, uses: [instrument_master], rejects: return}
  - {id: issuer_2, type: issuer, name: Konark Steel Ltd, symbol: KONSTL, feeds: instrument_master}
  # ...
flow:
  - broker_a -> fix_gateway                 # fan-in: one line per member
  - fix_gateway -> risk -> matching -> trade_bus -> clearing_feed -> clearing
  - matching -> md_publisher -> md_vendors  # fan-out: matching feeds several systems
alerts:
  - {name: "Member session disconnected", on: fix_gateway, metric: sessions_down, above: 0, severity: P2}
diagram:
  groups:
    - {label: "Members", ids: [broker_a, broker_b, broker_c, mm_1, mm_2]}
  place:                                    # optional [column, row]; auto-layout otherwise
    fix_gateway: [1, 2]
  steps:                                    # numbered on the diagram, listed beneath it
    - {from: broker_a, to: fix_gateway, text: "Brokers send client orders over FIX sessions."}
```

The validator explains problems in plain language: unknown types or components, loops in the flow, a Kafka topic without exactly one consuming service, alert rules on metrics a component does not have, diagram steps between components that are not connected, and more.

### Use case format (excerpt)

```yaml
id: exch-member-cannot-log-in
title: A broker cannot log in
systems: [exchange]
level: Easy
brief: >
  14:30, one hour before the clearing cut-off...
faults:
  - {at: "14:36", component: broker_b, fault: session_down}
noise:                                   # optional red herrings
  - {at: "14:43", name: "Disk usage 83% on md-node-1", severity: P4}
root_cause: {component: broker_b, fault: session_down}
accepted_fixes: [broker_b.reset_sequence]
risky_actions: [fix_gateway.restart]
hints:                                   # practice mode only, revealed over time
  - {after_min: 2, text: "One member's order flow dropped to zero..."}
debrief:
  what_happened: ...
  key_signal: ...
  why_not_restart: ...
  runbook: [step, step, step]
```

`mystery: true` with a `pool:` of scenarios picks one at random from those that fit the loaded system.

## Scoring (100 points)

| Part | Points | How |
|---|---|---|
| Acknowledged promptly | 15 | Time from first real alert (noise excluded) to acknowledgement |
| Correct root cause | 30 | 30 first time, 15 second time |
| Applied the right fix | 25 | An accepted action, and the fault cleared |
| Met the business deadline | 20 | Flow back to normal before the deadline, or the deadline KPI within tolerance |
| Safe operations | 10 | −5 per risky action, −3 per unnecessary action |

## Files

| File | Job |
|---|---|
| `src/engine.js` | Component types, blueprint validation, the simulator (flow graph, metrics, logs, alerts, health, faults, actions). No screen code. |
| `src/session.js` | Drill runner: schedules faults, records acknowledgement, declarations, tool use and approved actions; scores; builds the debrief. |
| `src/tools.js` | Splunk-style search, read-only SQL console, read-only Unix shell. |
| `src/app.js` | User interface: system picker, flow diagram, live map, tools, design editors, debrief. |
| `src/style.css`, `src/index.template.html` | Page design and layout. |
| `build.py` | Bundles everything, including the YAML files, into `dist/index.html`. |
| `tests/drills.test.js` | 92 automated tests (Node's built-in runner). |
| `vendor/js-yaml.min.js` | YAML parser (MIT licence, see `vendor/js-yaml.LICENSE`). |

## Develop

```bash
node --test tests/*.test.js    # validation, healthy steady state, every use case on every system it belongs to, tools
python3 build.py               # rebuild dist/index.html after editing src/, blueprints/ or drills/
```

The tests run every use case with a simulated responder who follows the runbook (must recover before the deadline and score at least 85) and one who acknowledges late, guesses wrong and takes a risky action (must score below 50). Mystery drills are tested across ten random picks.
