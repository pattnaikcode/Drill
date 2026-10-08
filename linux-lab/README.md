# OpsPilot Lab: real Linux, safe commands

A disposable Linux machine with a small "orders" app you can break for real,
and the OpsPilot runner that investigates it using only approved, read-only checks.

## Run it (needs Docker Desktop)

```
cd linux-lab
docker compose up --build
```

Open http://localhost:8080. Stop with Ctrl+C, then `docker compose down`.
First build takes 1–3 minutes (it downloads a small Python image). After that it starts in seconds.

## What's inside

| File | Job |
|---|---|
| `app/runner.py` | The only code that runs commands. Fixed catalogue, validated arguments, no shell, timeouts, redaction, audit. |
| `app/brain.py` | Runs the checks, reads the real outputs, writes FACT / INFERENCE / RECOMMENDATION. Every fact is copied from a check output. |
| `app/actions.py` | Changes to the system (restart app, delete archive files, stop runaway process). Need a named approver + confirmation. |
| `app/faults.py` | Lab-only chaos controls. Kept separate: OpsPilot can never call them. |
| `app/orders_app.py` | Fake Order Management service. Saves orders to the data disk; fails for real when the disk is full. |
| `app/audit.py` | Append-only audit trail of every check, rejection, fault and approval. |
| `docker-compose.yml` | 100 MB data disk, 768 MB memory and 1 CPU limits, so every fault stays inside the lab. |

## Demo (3 minutes)

1. Type `rm -rf /` in the terminal: rejected and audited. Type `df -h`: runs for real.
2. Click **Fill the data disk**, then **Investigate**: P1, disk 100% full, culprit folder named, real "No space left on device" errors quoted from the app log.
3. Click **Request approval**. Try without a name: blocked. Add a name, confirm: fixed. Investigate again: healthy.
4. Repeat with **Runaway CPU process** or **Memory leak**: the finding names the exact PID.
5. Show the **Audit trail**: every check, rejection, fault and approval with who and when.

## How to explain the safety model

- The AI never writes commands. It can only pick a check by name from the catalogue.
- Arguments are validated (paths must be inside approved log/data directories; names have strict patterns).
- Commands run as argument lists, so shell tricks (`;`, `&&`, `|`) are impossible.
- Anything that changes the system is a separate, approval-only action, and it only works on approved targets
  (e.g. it refuses to stop PID 1).
- Output is redacted for secrets before anyone sees it, and everything is audited.

In production the runner would sit inside the customer network, connect outwards only,
and run as a restricted user. The lab runs as root only because it is disposable.

## Honest scope

The investigation uses transparent rules, so it never invents a number. The next step is
to give the same evidence to an LLM under the same contract: every fact must cite a check
output, or the answer is rejected.
