# OpsPilot

Incident drills and investigation tooling for production support teams in capital markets.

Support teams are judged on how they handle business incidents: trades not allocated before cut-off, a Kafka partition that silently stops, settlement instructions missing, a vendor platform down. These are hard to practise safely. OpsPilot simulates realistic trading and middle-office systems, injects real faults, and scores how a responder detects, diagnoses and fixes them.

| Part | What it is | Runs |
|---|---|---|
| [`drill-simulator/`](drill-simulator/) | Design a system, add use cases, run them as scored drills. Built-in exchange (brokers, market makers, issuers, clearing) and middle-office trade allocation systems, each with a flow diagram. Investigate with Grafana-, Splunk-, SQL- and Unix-style tools. | In the browser, no install |
| [`command-center/`](command-center/) | Operations command center demo: alert correlation, incident lifecycle, evidence-based copilot, RCA, shift handover, SLA KPIs, log analyzer. | In the browser, no install |
| [`linux-lab/`](linux-lab/) | A real Linux machine you can break (disk full, crash, CPU, memory leak). Investigation runs only approved, read-only checks; fixes need a named approver. | Docker |

## Quick start

**Drill simulator:** open `drill-simulator/dist/index.html` in a browser. Choose a system, read its flow diagram, pick a use case, press Start.

**System Builder:** open `drill-simulator/dist/builder.html` to design a system with forms instead of writing YAML.

**Command center:** open `command-center/index.html` and press *Start scenario*.

**Linux lab:**

```bash
cd linux-lab
docker compose up --build
# open http://localhost:8080
```

To publish the browser parts with GitHub Pages: *Settings → Pages → Deploy from branch → `main` / root*. The landing page at the repository root links to both.

## What makes the drills different

- **Business impact, not just technical metrics.** Every drill runs against a real deadline (the 15:00 affirmation cut-off) and shows impact in ₹ Cr, the way a head of operations sees it.
- **Faults propagate; nothing is scripted.** A fault only changes one component's rules. Backlogs, consumer lag, alerts and missed cut-offs follow from the flow, so the same fault looks different on a different system design.
- **Configurable systems and use cases.** Design a system (members, gateways, Kafka, databases, issuers, external parties) in YAML, then add use cases to it, in the app or as files. Putting Kafka between two services is a two-line change; compare `blueprints/trade-allocation-kafka.yaml` with `trade-allocation-direct.yaml`.
- **Realistic investigation.** Splunk-style search, a read-only SQL console and a read-only Unix shell all read the live simulation. Participants' and vendors' servers are out of reach, as in real life.
- **A flow diagram for every system**, grouped by ownership with numbered business steps, available before and during a drill.
- **Safe-operations scoring.** Restarting a healthy service or acting on the wrong component costs points. Every change needs a named approver and confirmation, as in a regulated environment.
- **A debrief, not just a score:** timeline, time to detect / acknowledge / diagnose / recover, the signal to spot, why the obvious fix is wrong, and the runbook.

## Safety principles (all three parts)

1. Investigation is read-only by default. The AI or automation picks checks by name from a fixed catalogue; it never writes commands.
2. Anything that changes a system is a separate action that needs a named approver and explicit confirmation.
3. Every check, rejection, approval and action is audited.
4. Evidence first: facts are copied from real outputs and cite their source; inferences are labelled as inferences.
5. No real client data anywhere. Simulators use synthetic trades.

## Honest scope

- The drill simulator and command center are simulations. The Linux lab runs real commands on a disposable machine.
- The command center's copilot builds its answers from incident evidence with transparent rules. An LLM can replace it behind the same contract: every fact must cite a source, or the answer is rejected.
- Built by a production-support lead using AI-assisted development: the product design, domain modelling, safety model and testing are mine; much of the code was written with Claude.

## Roadmap

- More systems: bond issuance, OMS with smart order routing, payments.
- Assessment invites with a candidate report for hiring managers.
- Team readiness dashboard: drill history per engineer.
- Drills generated from a team's own (redacted) RCAs.
- Live mode: drills on real disposable containers, using the Linux lab's runner.
