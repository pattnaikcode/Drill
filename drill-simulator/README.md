# OpsPilot Drill Simulator

A browser-based incident drill simulator for production support teams. **Design a system, add use cases to it, and run them as scored drills**, investigating with Grafana-, Splunk-, SQL- and Unix-style tools.

Open it in any modern browser. No server, no install. There are two pages:

| Page | For | What it shows |
|---|---|---|
| `dist/index.html` | **Participants** | Systems, flow diagrams, use case briefs, the tools and the Respond panel. No fault injection, no use case files, no answers until the debrief. |
| `dist/admin.html` | **Instructors** | Everything above, plus the Design tab, the use case files, a sandbox where you can break anything, and an Instructor panel during a drill showing the answer, the faults active right now, and a control to add a curveball. |

Both are static files, so the split keeps answers off the participant's screen but cannot stop someone determined from opening the instructor page or the browser's developer tools. A hosted version would keep use case definitions on a server and send participants only what they may see.

## Built-in systems

| System | Architecture | Use cases |
|---|---|---|
| **Equity exchange trading platform** | 3 brokers and 2 market makers over FIX → order entry gateway → order validation (instrument master kept current by 3 listed issuers) → matching (order book store) → Kafka trade bus → clearing corporation; matching also feeds market data vendors and drop copy | Broker cannot log in · Market maker floods the gateway · Orders rejected in one stock (missed corporate action) · Matching slows to a crawl · Trades not reaching clearing · Some trades never reach clearing (stuck partition) · **Matching stops committing trades** (archive disk full on the database) · **Every member is disconnected** (gateway clock drift) · **Clearing stops accepting trades again** (expired TLS certificate) · **Orders slow down in pre-trade risk** (bad configuration change to an API timeout) · Mystery (10 possible faults) |
| **Middle-office trade allocation** (with Kafka) | OMS and execution desk → Kafka → allocation engine (SSI reference data, allocation DB) → confirmation platform → settlement | Allocations falling behind · One partition stuck · Missing settlement instructions · Confirmations not matching · Allocation engine choking · **Allocation engine keeps restarting** (out of memory) · **Confirmations crawl through** (API rate limit, HTTP 429) · **Confirmation platform rejects everything** (expired API credentials, HTTP 401) · Mystery (9 possible faults) |
| **Middle-office trade allocation** (direct) | Same system without Kafka, to compare designs | All of the above except the stuck partition |

**Example system to build yourself:** `examples/fraud-aml-platform.yaml` is a bank's real-time fraud and AML monitoring platform (core banking, card switch and UPI switch → ingestion gateway → Kafka → detection engine using a customer profile store and sanctions/PEP watchlists → decisions back to channels, case management, FIU-IND reporting). It is listed with the built-in systems (every file in `examples/` is), and you can also rebuild it yourself in the Designer or System Builder. Its seven use cases: payments slow down across every channel (profile store pool exhausted), sanctions screening on yesterday's list (stale watchlists), UPI stops reaching screening, detection engine crash loop, some transactions never scored (poison message), FIU-IND reports failing (HTTP 401), and a mystery. Five AML use cases sit alongside them: high-risk customers look low-risk (KYC risk ratings failed to load), AML alerts pile up unreviewed (case management lost an instance), monthly reports crawl to FIU-IND (HTTP 429 on deadline day), cases created slowly after a quiet configuration change, and an AML mystery.

**Second example to build yourself:** `examples/online-shopping.yaml` is an online shopping platform (website, Android and iOS apps → API gateway → checkout using the product catalogue and inventory database → payment gateway → Kafka → fulfilment → warehouse → delivery partner, plus SMS and email notifications). Seven use cases: flash sale items fail at checkout (catalogue load failed), checkout slows for everyone (inventory DB pool), customers cannot pay (gateway outage), paid orders not shipped (delivery partner HTTP 401), checkout crash loop in a sale, orders stuck after an app release (poison message), and a mystery.

**Sector examples built only from the component library** (each listed in the apps, with three use cases):

| System | Built from | Use cases |
|---|---|---|
| **Motor insurance** (`examples/motor-insurance.yaml`) | Quote channels → API gateway → rating engine (rate tables) → policy administration (policy DB) → document generation → email/post; claims intake → claims system → cashless-repairs TPA | Quotes blocked after a rate release · Quotes refused in some regions (rate table load failed) · New customers get no policy documents (template error) |
| **IPO issuance** (`examples/ipo-issuance.yaml`) | Brokers and apps → bidding platform (security master) → sponsor bank (UPI mandates) → registrar → allotment engine → depository | Retail bids rejected (price band set up wrong) · Investors not getting UPI mandates · Bids without blocked funds (reconciliation) |
| **Retail bank cards, ATMs and UPI** (`examples/bank-cards-upi.yaml`) | ATMs and card terminals → card switch (ISO 8583, HSM) → core banking (accounts DB) → SMS; UPI requests → UPI switch → core banking | PIN transactions declined after key rotation · All card transactions stop (link signed off) · Slow authorisations (end-of-day batch overran) |
| **Store chain and online shop** (`examples/store-chain.yaml`) | Web and app → API gateway → storefront (cart cache, search index) → payment gateway → message queue; store tills → sales hub → message queue → stock service → warehouse | App users get HTTP 429 (rate limit config) · Orders paid but not reaching the warehouse (no consumers) · Queue stuck on one bad message |

Every system has a **flow diagram** with groups (who owns what) and numbered steps describing the business flow. Participants see it before they start and can open it at any time during a drill.

## How a drill works

1. Choose a system and read its flow diagram.
2. Choose a use case. Faults are injected at the scheduled time without telling you what or where.
3. Investigate with the live map, component inspector and four tools (below).
4. Acknowledge, declare the root cause, and request fixes. Every change needs a named approver and confirmation.
   - **Root cause**: choose where (any component) and what from one list of causes that is the same for every component and includes plausible causes that never happen in this simulator. Write the evidence that supports it; it appears in the debrief.
   - **Actions**: each kind of component has its full runbook catalogue, with fixes, heavy-handed options (reboot, fail over to DR) and harmful ones (purge a queue, which loses trades) side by side. Nothing marks which is which.
5. The drill ends when business flow is back to normal or the deadline passes. You get a score and a debrief: timeline, time to detect / acknowledge / diagnose / recover, every tool query you ran, the signal to spot, why the obvious fix is wrong, and the runbook.

## Nested and API failures

Services, databases, adapters and loaders run on **hosts**, and hosts fail underneath the application. The alert names the symptom; the cause is one or two layers down.

| Host fault | Where | What you see first | Where the evidence is | Fix |
|---|---|---|---|---|
| `disk_full` | any host | Database: every commit hangs (ORA-00257), the pool fills, the service using it stalls. Service: requests fail writing logs. | `df -h`, `dmesg`, `v$session` event "log file switch (archiving needed)" | `clear_disk_space` |
| `memory_oom` | service | Throughput comes in bursts | `kubectl get pods` CrashLoopBackOff, `kubectl describe pod` OOMKilled exit 137, `dmesg` | `increase_memory_limit` |
| `cpu_runaway` | service, database | Slow processing, high latency | `top` shows a backup job at 98% CPU, load average 15 | `kill_runaway_process` |
| `fd_exhausted` | service, adapter | Some calls fail | "Too many open files", `lsof -p 3120 \| wc -l` = 4096, mostly CLOSE_WAIT | `raise_fd_limit` |
| `clock_skew` | service | Every participant rejected at logon | "SendingTime accuracy problem", `date`, `chronyc tracking` | `resync_ntp` |
| `cert_expired` | adapter | Looks exactly like the external party being down | SSLHandshakeException, `openssl x509 -enddate` | `renew_certificate` |

**API faults:** `api_rate_limited` (HTTP 429; our adapter retries immediately and makes it worse; fix `enable_retry_backoff`), `api_auth_expired` (HTTP 401 invalid_client; fix `rotate_api_credentials`) on external parties, and `config_change` on services (an automated configuration refresh set an API read timeout to 50 ms; "no deployment" is not "no change"; fix `revert_config`).

Components with the same `host:` run on one server and share it: a full disk or a reboot hits every process on it. `mount:` sets the path the host's data lives on.

Rebooting a host or failing over to DR fixes some host faults but takes the component away for four to five minutes; restarting the application fixes none of them.

## Kinds: add a component in one line

Define each kind of component once, and each new one is a single line. It is connected and placed in its diagram group automatically:

```yaml
kinds:
  broker:       {type: source, role: Broker, connects_to: fix_gateway, group: Members, defaults: {rate_per_min: 300}}
  market_maker: {type: source, role: Market maker, connects_to: fix_gateway, group: Members, defaults: {rate_per_min: 450}}

components:
  - {id: mm_1, kind: market_maker, name: Arcline Markets, session: ARCL11, rate_per_min: 600}
  - {id: mm_3, kind: market_maker, name: Ganga Liquidity, session: GNGA13}     # new: nothing else to edit
  - {id: "mm_x{n}", kind: market_maker, count: 3}                             # or several at once
```

A kind can set `type`, `role`, `connects_to`, `connects_from`, `group`, `uses`, `defaults`, and templates for `name` and `session` (`{id}`, `{ID}`, `{n}`). Values on the component line win over the kind's. Diagram groups can also list `roles: [Broker, Market maker]` instead of ids. Journeys can use `at: "role:Broker"` and order fields like `counterparty: "role:Market maker"`, so a new member appears in traced orders too. The exchange is written this way.

## Packs: new technologies without code

A pack (`packs/*.yaml`) adds component types. Each new type **behaves like** one of the built-in behaviours (`source`, `service`, `kafka_topic`, `external_party`, `ref_data`, `database`) and brings its own faults, fixes, log lines and shell commands. The engine applies a pack fault only through generic **effects**:

| Effect | Meaning |
|---|---|
| `capacity: 0.3` | works at 30% of normal throughput |
| `errors: 0.6` | 60% of calls fail |
| `reject: 0.12` | 12% of work is rejected (on this component, or on services that use this reference data) |
| `down: true` | nothing gets through; `reason` explains why (shown to traced orders) |
| `stale: true` | a loader stops refreshing (services that use it reject work) |
| `pool_full: true` | a database's connections are all taken |

Actions can `fixes: [fault]` (optionally `after_s` to take effect later), `restart_s` (rolling restart), `outage_s` (down while restarting), `drops_queue` (harmful: waiting work is lost) and `replays_rejected`. A pack fault can also list built-in actions that fix it (`fixed_by`), and a `hint` shown when someone tries a restart. `vars` define names used in messages (`QMGR: "QM_{ID}"`), and `shell` maps commands to their output; a fault's `evidence` replaces that output while it is active.

### The component library

Each pack is a sector's set of ready-made components. Pick one in the Designer (search the palette, e.g. "queue", "FIX", "claims") and it already knows its faults, fixes, logs and commands. Every type also has sensible default sizes (`defaults`), so a new box works before you set anything.

| Pack | Components | Typical faults (each has a correct fix and harmful decoys) |
|---|---|---|
| **`capital-markets`** | FIX session gateway, market data feed handler, order management system, smart order router, central securities depository | Resend storm after a sequence gap, heartbeat timeout; A/B line gaps, silent feed; start-of-day limits not loaded, position lock; venue marked down; settlement instructions rejected |
| **`retail-banking`** | Core banking system, card switch (ISO 8583), HSM, UPI / instant payment switch, national payment network, SWIFT gateway, ATM fleet | End-of-day batch overrun, stand-in mode; link signed off (0800 echo), issuer timeouts (RC 91); zone PIN key not loaded; responses late ("deemed"); network degraded; messages NAKed, session closed |
| **`retail-ecommerce`** | API gateway, message queue (broker), cache, payment gateway, product search index, store sales sync hub | Rate limit too low (429), signing keys out of date (401), upstream pool exhausted (504); no consumers, memory alarm, poison message; eviction storm, keys without expiry; acquirer timeouts, 3-D Secure outage; indexing stuck; stores offline, duplicate uploads |
| **`insurance`** | Quote channel, rating engine, rate tables, policy administration, document generation, claims system, third-party administrator, reinsurer | Rating timeouts, wrong factor table; rate table load failed; renewal batch overrun, product setup missing; template error, render backlog; cover check failing, fraud rule too strict; TPA API down; bordereau rejected |
| **`issuance`** | Bid channel, bidding platform, sponsor bank (UPI mandates / ASBA), registrar (RTA), allotment engine, security master | Price band wrong, closing-day surge; mandates delayed; reconciliation mismatch; credit file rejected; ISIN not activated |
| **`ibm-mq`** | IBM MQ queue manager | Sender channel stopped (`AMQ9999E`, `STATUS(RETRYING)`), transmission queue full (`MQRC 2053`), messages to the dead-letter queue (`AMQ9544E`, reason 2085). Harmful: `CLEAR QLOCAL`, restarting the queue manager |
| **`batch-files`** | Start-of-day file load | File not received, file incomplete (trailer count mismatch). Harmful: load yesterday's file |

`tests/packs.test.js` puts every component type into a small system, breaks it with each of its faults, checks the fault is visible (errors in the logs plus a queue, rejects, stale data, a full pool or an error rate) and that the action meant to fix it does. Add a type and it is tested the same way.

`examples/payments-mq.yaml` uses both: channels → payment engine (customer static from the start-of-day file) → IBM MQ → SWIFT gateway before the RTGS cut-off, with four use cases. Pack faults appear in the root-cause list and the instructor's fault menu, pack actions in the runbook, pack types in the System Builder.

## Follow an order

The **Follow an order** tool sends one order through the live system and shows it hop by hop: the raw FIX message at each step (with `|` for the SOH separator), what each component does with it, and the database rows it writes. The exchange has four journeys: fully filled against a market maker's quote, stopped by the broker's own risk checks (it never reaches the venue), rejected by the venue's price band, and partly filled with the rest left on the book. Client risk (margin, limits, fat-finger checks) sits with the broker; the venue only validates the order (tradable instrument, price band, tick and lot size). Rows land in `orders` and `trades` on the Order Book Store, so you can query them in the Database tab.

A journey can branch with `from:`. After matching, the same trade is followed to clearing and, through its own Kafka consumer group, to market surveillance. If clearing is stuck, surveillance still receives the trade, and the other way round, just as with two independent consumer groups.

Orders move through the same simulation as the bulk traffic, so a fault stops them where the problem is. A stuck Kafka partition holds only the orders keyed to that partition. A missed corporate action rejects the order at risk. A full archive disk leaves it waiting at matching. An expired certificate stops it at clearing. A gateway clock problem leaves it queued at the broker, because its TCP session cannot log on. Fix the fault and the order resumes, recording how long it waited.

Journeys are data in the system YAML:

```yaml
tables:
  orders: {db: orderbook_db, columns: [order_id, clordid, member, symbol, side, qty, price, filled_qty, status, created_at, updated_at]}
journeys:
  - id: filled
    name: Buy order fully filled
    order: {member: KEST01, symbol: KONSTL, side: BUY, qty: 100, price: 1203.40}
    steps:
      - at: broker_a
        does: "Kestrel's FIX engine sends a NewOrderSingle (35=D) over its TCP session to our OEGW."
        message: "8=FIX.4.4|35=D|49=KEST01|56=OEGW|34={seq}|11={clordid}|55=KONSTL|54=1|38=100|40=2|44=1203.40|"
      - at: fix_gateway
        does: "Session, sequence and throttle checks; assigns {order_id}; acknowledges with 35=8."
        writes: ["orders: insert status=PENDING_NEW filled_qty=0"]
      - at: risk
        reject: "Price outside band"        # optional: a step that always rejects
```

Each step must follow the flow (`at` components connected by `->`), and writes must name a declared table. The validator explains any mistake.

## Investigation tools

All tools read the live simulation, so what you find depends on what is actually broken. All are read-only.

| Tool | What it does | Try |
|---|---|---|
| **Grafana** | Time-series panels for every component, with alert thresholds | Overview dashboard, or one component's dashboard |
| **Splunk** | Search every component's logs. Fields `component=` `level=` `earliest=-15m`, `"phrases"`, `NOT`. Commands `stats count by component|level|pattern`, `top pattern` (groups lines that differ only by IDs and numbers), `timechart count`, `head` | `level=ERROR \| stats count by component` |
| **Database** | SQL console on each database: `v$session`, `sessions` (FIX sessions and sequence numbers), `rejects`, `corporate_actions`, `instruments`, reference data load logs. `SELECT … WHERE … GROUP BY … ORDER BY … LIMIT`, `SHOW TABLES`, `DESCRIBE`. Anything that changes data is refused. | `SELECT * FROM sessions` |
| **Unix** | Shell on each host the support team owns: `tail`, `grep`, `ps`/`top`, `df -h`, `free`, `dmesg`, `chronyc tracking`, `ulimit -n`, `lsof`, `openssl x509 -enddate`, `kubectl get/describe pods`, `kafka-consumer-groups.sh --describe`, `curl` health, `cat` config, with pipes to `grep`, `tail`, `head`, `wc -l`, `sort`. `rm`, `kill`, `sudo`, restarts and other changes are refused. | `kubectl get pods \| grep Pending` |

Participants' and vendors' own servers are deliberately not reachable, just as in real life.

## Design your own

**Designer (drag and drop):** open `dist/designer.html`. Drag components from the palette onto the canvas (or click a tile to add it next to the selected box), drag from a box's blue dot onto another box to connect it (a service to a database or reference data becomes "reads from"; an issuer to reference data becomes "publishes to"), and edit names, capacities and other settings on the right. With nothing selected, the right panel sets the system's name, deadline, business KPIs, alert rules and diagram groups. The palette includes every pack type, folded by sector (a sector opens when its components are in the design), the kinds defined in the loaded system, and a search box. The simulator's own validator runs after every change and marks problems on the boxes they belong to. Undo, Tidy layout, Delete and arrow-key moves are supported. **Save to simulator** stores it for the instructor page (same site); **YAML** shows and copies the result.

**System Builder (no YAML typing):** open `dist/builder.html`. Add components from a list of types (each with a plain-language explanation), connect them, set business KPIs, alert rules, diagram groups and numbered steps. The YAML is written as you go and checked by the simulator's own validator, with every problem explained in plain language. You can start blank, from a built-in system, or from pasted YAML; renaming a component updates every reference to it. The page also explains how each part of the YAML works. Copy the result into the simulator's Design tab.

The instructor page's **Design** tab has two editors:

1. **System**: write or edit a blueprint, check it, and save. It appears as a new system on the Drills tab.
2. **Use case**: write a drill for the loaded system, starting from a template or a copy of an existing one. It appears under that system.

A **Your saved designs** list shows what you have saved in this browser, each with a Delete button (an edited built-in system goes back to its original). A reference table lists every component of the loaded system with the faults it can have and the actions that fix them, so you can write use cases without reading code. Designs are saved in the browser; to keep them in the project, copy the YAML into `blueprints/` or `drills/` and run `python3 build.py`.

## How it works

Three layers keep it configurable:

| Layer | Where | Changes when |
|---|---|---|
| **Component types**: how a kind of thing behaves, what it measures, how it fails and how it is fixed | `src/engine.js` (`TYPES`) | You need a new kind of building block (rare) |
| **System blueprint**: components, flow, alert rules, flow diagram | `blueprints/*.yaml` | You model a new system |
| **Use case (drill)**: fault and timing, correct answer, scoring, debrief | `drills/*.yaml` | You write a new exercise |

The flow is a graph: many members can feed one gateway, and one matching engine can feed clearing, market data and drop copy at once. Every simulated 5 seconds, work moves through the graph in dependency order; each component takes what its capacity allows and passes it on. A fault only changes one component's rules (a member's session rejected, a flood of messages, a missed corporate action, a blocked partition, an exhausted connection pool, an unavailable vendor). Queues, lag, rejects, alerts and the deadline projection all follow from the flow, nothing is scripted.

### Component types

Every component type also gets the host faults above where they apply, and the full runbook catalogue for its type (see `ACTIONS` in `src/engine.js`, or the reference table in the instructor page's Design tab).

| Type | Required | Metrics (for alert rules) | Application faults | Example fix actions |
|---|---|---|---|---|
| `source` (participant) | `rate_per_min` (+ `role`, `session`) | `out_rate`, `held` | `session_down`, `order_flood` | `reset_sequence`, `apply_throttle` |
| `kafka_topic` | `partitions` (+ `consumer_group`, `keys` and `weights` per partition, `assign` to give several consumers their own partitions) | `lag`, `max_partition_lag`, `in_rate`, `out_rate`, `rebalances` | `poison_message`, `rebalance_storm` | `skip_poison_message`, `tune_consumer_timeout` |
| `service` | `capacity_per_min` (+ `instances`, `uses`, `rejects: queue\|return`) | `in_rate`, `out_rate`, `backlog`, `reject_rate`, `error_rate`, `instances`, `latency_ms`, `rejected`, `sessions_down`, `host_cpu_pct`, `host_mem_pct`, `host_disk_pct` | `instances_lost`, `config_change` | `scale_out`, `revert_config`, `restart`, `reprocess_rejected` |
| `external_party` | `capacity_per_min` | `in_rate`, `out_rate`, `backlog`, `error_rate`, host metrics | `unavailable`, `api_rate_limited`, `api_auth_expired` | `escalate_to_vendor`, `enable_retry_backoff`, `rotate_api_credentials`, `restart_adapter` |
| `ref_data` | `refresh_every_min`, `stale_after_min` | `staleness_min` | `feed_failed` | `force_refresh` |
| `database` | `pool_size` (+ `engine: oracle\|postgres`; Postgres changes the error messages, mounts and the SQL view to `pg_stat_activity`) | `pool_used`, `pool_pct`, `wait_ms` | `pool_exhausted` | `kill_blocking_session` |
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
  - {id: fix_gateway, type: service, name: Order Entry Gateway (OEGW), capacity_per_min: 2700, instances: 3}
  - {id: risk, type: service, name: Order Validation, capacity_per_min: 2800, uses: [instrument_master], rejects: return}
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
| `src/engine.js` | Component types, hosts and host faults, the runbook action catalogue, the root-cause list, blueprint validation, the simulator (flow graph, metrics, logs, alerts, health, faults, actions). No screen code. |
| `packs/*.yaml` | The component library: sector packs (capital markets, retail banking, retail and e-commerce, insurance, issuance) and technology packs (IBM MQ, start-of-day file loads), all configuration. |
| `src/trace.js` | Follow an order: traced orders that move hop by hop through the live simulation, and the tables they write. |
| `src/session.js` | Drill runner: schedules faults, records acknowledgement, declarations, tool use and approved actions; scores; builds the debrief. |
| `src/tools.js` | Splunk-style search, read-only SQL console, read-only Unix shell. |
| `src/app.js` | User interface: system picker, flow diagram, live map, tools, design editors, debrief. |
| `src/designer.js`, `src/designer.template.html` | Designer: drag-and-drop canvas that writes and validates blueprint YAML. |
| `src/builder.js`, `src/builder.template.html` | System Builder: forms that write and validate blueprint YAML. |
| `src/style.css`, `src/index.template.html` | Page design and layout. |
| `build.py` | Bundles everything, including the YAML files, into `dist/index.html` (participant page), `dist/admin.html` (instructor page), `dist/designer.html` (Designer) and `dist/builder.html` (System Builder). |
| `tests/*.test.js` | 270 automated tests (Node's built-in runner). |
| `vendor/js-yaml.min.js` | YAML parser (MIT licence, see `vendor/js-yaml.LICENSE`). |

## Develop

```bash
node --test tests/*.test.js    # validation, healthy steady state, every use case on every system it belongs to, tools
python3 build.py               # rebuild dist/*.html after editing src/, blueprints/ or drills/
```

The tests run every use case with a simulated responder who follows the runbook (must recover before the deadline and score at least 85) and one who acknowledges late, guesses wrong and takes a risky action (must score below 50). Mystery drills are tested across ten random picks.
