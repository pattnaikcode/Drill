# Design Notes — Drill

## Why I built it

I have around 13 years of experience in application and production support, primarily in financial services and capital markets. My work involved exchange and MTF systems, Kafka, Oracle, Linux, and market surveillance.

One recurring challenge in production support is that engineers often learn how to handle major incidents while an actual outage is happening. They may know the application, but not how to investigate unfamiliar symptoms, correlate evidence across systems, identify the underlying cause, or coordinate recovery under pressure.

I started building Drill during my career break in 2026 to address this problem: a controlled environment where support engineers can practise incident investigation and recovery without affecting production. I used Claude to write much of the code, while I provided the domain knowledge, designed the architecture and scenarios, reviewed the implementation, and tested the behaviour.

## Architecture and operational experience

I modelled the simulated environments on systems I had worked with. For example, the MTF environment represents institutional order flow through FIX over TCP, retail access through REST APIs, and a matching engine with three processing tiers. The surveillance environment models the flow from exchange adapters through Avro and Kafka to surveillance data nodes, reference data, and query services.

In the surveillance design, Kafka partitions are mapped to underlying instruments through server-specific configuration. Data nodes consume the relevant streams and write transaction files, while the surveillance system uses start-of-day reference data to map incoming events. These dependencies matter because an incident that appears to be an application problem may actually originate in configuration, data flow, infrastructure, or reference data.

One real operational pattern that influenced the scenarios was uneven workload distribution across surveillance nodes. Node rebalancing was infrequent, allowing a busy underlying to overload its assigned node and cause surveillance processing to fall behind.

## Key design decisions

- **Architecture before scenarios:** Each simulated system has its own architecture and use cases. Participants can refer to a flow diagram instead of investigating without understanding the system.
- **Evidence-based investigation:** Scenarios require participants to correlate evidence from database queries, Unix commands, Splunk, Grafana, and application behaviour.
- **Configuration-driven scenarios:** I wanted a form-based builder that generates YAML, making scenarios easier to create and maintain without manually editing configuration files.
- **Separate participant and administrator views:** The administrator can configure and inject faults, while participants investigate without seeing the injected failure or its intended answer.
- **Root cause should be discovered, not revealed:** I initially used dropdowns for root causes and fixes, but realised this gave away the answer. I changed the design to use a common cause list across components, require written evidence, and provide a complete runbook action list for recovery.
- **Failures across layers:** The scenarios account for nested failures, such as a Unix process or disk problem presenting as an application outage, alongside API and application-level failures.

I also explored expanding the same approach to trade allocation, fraud and AML operations, and an online shopping platform, each with its own architecture and failure scenarios.

## What I learned building with AI

Using Claude accelerated implementation, but generating code was only part of the work. I still needed to validate whether the application behaved like a support environment.

For example, I identified issues where the interface exposed the expected root cause, the scenario builder failed to preserve fields, and database investigation messages were too closely tied to Oracle rather than supporting the intended investigation context. These issues reinforced the importance of reviewing the complete workflow, not just whether the code runs.

My main takeaway is that AI can speed up development, but domain knowledge, testing, and sound operational judgement are necessary to make the result useful.

## Limitations and what comes next

Drill is currently a simulator, not a production-connected incident-management platform. Its systems, evidence, and failures are simplified representations of real environments. A next step would be to introduce a proper server-side scenario engine so answers remain hidden, persistent team assessments to track performance over time, and integrations with tools such as ServiceNow and Splunk.

The longer-term goal is to help support teams practise structured investigation, improve recovery readiness, validate runbooks, and identify gaps in tooling, access, and incident communication before a real outage occurs.
