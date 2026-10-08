# OpsPilot Drill Simulator

A browser-based incident drill simulator. Describe a system as a YAML **blueprint**, describe incidents as YAML **drills**, and run them against a ticking clock with a business cut-off.

Open `dist/index.html` in any modern browser. No server, no install.

## How it works

Three layers keep it configurable:

| Layer | Where | Changes when |
|---|---|---|
| **Component types**: how a kind of thing behaves, what it measures, how it fails, how it is fixed | `src/engine.js` (`TYPES`) | You need a new kind of building block (rare) |
| **Blueprint**: which components a system has and how they connect | `blueprints/*.yaml` | You model a new system |
| **Drill**: which fault hits which component, the right answer, scoring | `drills/*.yaml` | You write a new exercise |

Every simulated 5 seconds, work flows along the blueprint's chain. The source produces trades; each component takes what its capacity allows and passes it on. A fault only changes one component's rules (fewer instances, a blocked partition, stale reference data, an exhausted connection pool, an unavailable vendor). Backlogs, lag, alerts and the cut-off projection all follow from the flow.

```
oms ──► trades_topic ──► tam ──► ctm ──► settle
         (Kafka)          │
                     ┌────┴────┐
                    ssi      tam_db
              (ref data)   (database)
```

### Files

| File | Job |
|---|---|
| `src/engine.js` | Component types, blueprint validation, the simulator (flow, metrics, logs, alerts, health, faults, actions). No screen code. |
| `src/session.js` | Drill runner: schedules faults, records acknowledgement, root-cause declarations and approved actions, scores the result, builds the debrief. |
| `src/app.js` | User interface. Draws state and turns clicks into engine calls. |
| `src/style.css`, `src/index.template.html` | Page design and layout. |
| `build.py` | Bundles everything (including the YAML files) into `dist/index.html`. |
| `tests/drills.test.js` | Automated tests (Node's built-in runner). |
| `vendor/js-yaml.min.js` | YAML parser (MIT licence, see `vendor/js-yaml.LICENSE`). |

## Blueprint format

```yaml
id: trade-allocation-kafka
system: Middle-office trade allocation
clock: {start: "13:30", cutoff: "15:00"}
business:
  currency: "₹"
  unit: "Cr"
  avg_notional: 0.6            # per trade, to show impact in money
  produced_at: oms
  kpis:
    - {label: "Unallocated", at: tam}
    - {label: "Not yet affirmed", at: ctm, cutoff: true}
components:
  - {id: oms, type: source, name: Order Management, rate_per_min: 300}
  - {id: trades_topic, type: kafka_topic, name: trades.executed, partitions: 6, consumer_group: tam-allocator}
  - {id: tam, type: service, name: Allocation Engine, capacity_per_min: 420, instances: 4, uses: [ssi, tam_db]}
  - {id: ssi, type: ref_data, name: SSI Reference Data, refresh_every_min: 15, stale_after_min: 20}
  - {id: tam_db, type: database, name: Allocation DB, pool_size: 50}
  - {id: ctm, type: external_party, name: Confirmation Platform (CTM), capacity_per_min: 520}
  - {id: settle, type: external_party, name: Settlement (SWIFT), capacity_per_min: 600}
flow:
  - oms -> trades_topic -> tam -> ctm -> settle
alerts:
  - {name: "Kafka consumer lag high", on: trades_topic, metric: lag, above: 900, severity: P2}
```

### Component types

| Type | Required | Metrics (for alert rules) | Faults | Fix actions |
|---|---|---|---|---|
| `source` | `rate_per_min` | `out_rate` | — | — |
| `kafka_topic` | `partitions` | `lag`, `max_partition_lag`, `in_rate`, `out_rate`, `rebalances` | `poison_message`, `rebalance_storm` | `skip_poison_message`, `tune_consumer_timeout` |
| `service` | `capacity_per_min` (+ optional `instances`, `uses`) | `in_rate`, `out_rate`, `backlog`, `reject_rate`, `error_rate`, `instances`, `latency_ms`, `rejected` | `instances_lost` | `scale_out`, `restart`, `reprocess_rejected` |
| `external_party` | `capacity_per_min` | `in_rate`, `out_rate`, `backlog`, `error_rate` | `unavailable` | `escalate_to_vendor`, `restart_adapter` |
| `ref_data` | `refresh_every_min`, `stale_after_min` | `staleness_min` | `feed_failed` | `force_refresh` |
| `database` | `pool_size` | `pool_used`, `pool_pct`, `wait_ms` | `pool_exhausted` | `kill_blocking_session` |

Rules the validator enforces: ids are lowercase; every flow starts with a `source`; a Kafka topic needs a consumer after it; reference data and databases attach to a service with `uses`, not the flow; alert rules name a metric the component actually has; at most one KPI is the cut-off KPI. Errors are reported in plain language with the offending line.

**Inserting Kafka** between two systems is one new component and one changed flow line. With Kafka in between, a slow consumer no longer slows the producer, the early signal becomes consumer lag, and a single stuck partition becomes possible.

## Drill format

```yaml
id: stuck-partition
title: One partition stuck
level: Medium
summary: Overall flow looks almost normal, but part of the book is not being allocated.
brief: >
  13:30. Everything looked fine at the start of the afternoon...
faults:
  - {at: "13:35", component: trades_topic, fault: poison_message, params: {partition: 3}}
noise:                                   # optional unrelated alerts (red herrings)
  - {at: "13:43", name: "Disk usage 82% on report-01", severity: P4}
root_cause: {component: trades_topic, fault: poison_message}
accepted_fixes: [trades_topic.skip_poison_message]
risky_actions: [tam.restart]
hints:                                   # practice mode only, revealed over time
  - {after_min: 4, text: "Is the lag spread evenly across partitions?"}
debrief:
  what_happened: ...
  key_signal: ...
  why_not_restart: ...
  runbook: [step, step, step]
```

A drill with `mystery: true` and a `pool:` of scenarios picks one at random. A drill is only offered on blueprints that have the components it needs.

## Scoring (100 points)

| Part | Points | How |
|---|---|---|
| Acknowledged promptly | 15 | Time from first real alert (noise excluded) to acknowledgement |
| Correct root cause | 30 | 30 first time, 15 second time |
| Applied the right fix | 25 | An accepted action, and the fault cleared |
| Met the business cut-off | 20 | Flow back to normal before cut-off, or cut-off KPI within tolerance |
| Safe operations | 10 | −5 per risky action, −3 per unnecessary action |

Every action needs a named approver and confirmation; the session refuses it otherwise.

## Develop

```bash
node --test tests/*.test.js    # 31 tests: validation, steady state, every drill with good and careless responders
python3 build.py               # rebuild dist/index.html after editing src/, blueprints/ or drills/
```

The tests run each drill with a simulated responder who follows the runbook (must recover before cut-off and score at least 85) and one who acknowledges late and restarts the allocator (must score below 50).
