"""Investigation 'brain'. It decides which approved checks to run, reads the real outputs,
and writes findings separated into FACT / INFERENCE / RECOMMENDATION.

This version uses transparent rules, so it can never invent a number: every fact is
copied from a check output. A later version can hand the same evidence to an LLM under the
same contract (every fact must cite a check, or the answer is rejected)."""
import re
from runner import run_check
from config import DATA_DIR

def _df_usage(out):
    rows = []
    for line in out.splitlines()[1:]:
        p = line.split()
        if len(p) >= 6 and p[4].endswith("%"):
            rows.append((p[5], int(p[4][:-1]), p[1], p[3]))
    return rows

def investigate():
    ev, findings = {}, []
    for name in ["app_health", "process_running", "disk_usage", "container_memory", "memory", "top_processes", "count_errors"]:
        ev[name] = run_check(name, {}, actor="opspilot")
    ev["tail_log"] = run_check("tail_log", {"lines": "15"}, actor="opspilot")

    health = ev["app_health"]["output"]
    app_up = ev["process_running"]["rc"] == 0
    healthy = "HTTP 200" in health

    # 1. App process down
    if not app_up:
        findings.append({"title": "Orders app process is not running", "severity": "P1",
            "facts": [("process_running", "pgrep found no orders_app process."), ("app_health", f"Health check returned: {health}")],
            "inference": "The service is down because its process has stopped. Nothing is listening on port 9000.",
            "recommendation": "Restart the orders app, then check the log for the reason it stopped.",
            "action": {"name": "restart_app", "args": {}}})

    # 2. Disk full on the data disk
    for mount, pct, size, avail in _df_usage(ev["disk_usage"]["output"]):
        if pct >= 90 and (mount == DATA_DIR or mount == "/"):
            facts = [("disk_usage", f"{mount} is {pct}% full ({avail} free of {size}).")]
            big = run_check("largest_files", {"path": DATA_DIR}, actor="opspilot"); ev["largest_files"] = big
            top = sorted((l.split("\t") for l in big["output"].splitlines() if "\t" in l), key=lambda x: _bytes(x[0]), reverse=True)
            children = [t for t in top if t[1].rstrip("/") != DATA_DIR.rstrip("/")]
            if children: facts.append(("largest_files", f"Largest item: {children[0][1]} ({children[0][0]})."))
            if "No space left" in ev["tail_log"]["output"]:
                facts.append(("tail_log", "App log shows 'No space left on device' when saving orders."))
            findings.append({"title": f"Data disk {mount} is full", "severity": "P1" if not healthy else "P2", "facts": facts,
                "inference": "Orders cannot be saved because the data disk is full; archive files are using the space.",
                "recommendation": "Delete the archive files (after confirming they are backed up), then fix the job that writes them.",
                "action": {"name": "clear_archive_files", "args": {}}})

    # 3. Runaway CPU / memory processes
    for line in ev["top_processes"]["output"].splitlines()[1:]:
        p = line.split(None, 5)
        if len(p) < 6: continue
        pid, pcpu, pmem, rss_kb, cmd = p[0], float(p[1]), float(p[2]), int(p[3]), p[5]
        if "uvicorn" in cmd or "ps -eo" in cmd: continue
        if pcpu >= 60:
            findings.append({"title": f"Runaway CPU process (PID {pid})", "severity": "P2",
                "facts": [("top_processes", f"PID {pid} uses {pcpu:.0f}% CPU: {cmd[:70]}"), ("load", run_check('load', actor='opspilot')['output'])],
                "inference": "A single process is consuming a full CPU core, which can slow every service on this host.",
                "recommendation": f"Identify the owner of PID {pid}; stop it if it is not business-critical.",
                "action": {"name": "stop_runaway_process", "args": {"pid": pid}}})
        elif rss_kb > 200 * 1024:
            findings.append({"title": f"Process holding {rss_kb//1024} MB memory (PID {pid})", "severity": "P2",
                "facts": [("top_processes", f"PID {pid} resident memory {rss_kb//1024} MB ({pmem:.1f}% of host): {cmd[:70]}")] + _mem_fact(ev),
                "inference": "Memory use by this process is abnormally high and growing; it is likely leaking.",
                "recommendation": f"Capture a heap dump if needed, then stop or restart PID {pid}.",
                "action": {"name": "stop_runaway_process", "args": {"pid": pid}}})

    # 4. Error flood in logs
    try: errors = int(ev["count_errors"]["output"].split()[0])
    except (ValueError, IndexError): errors = 0
    if errors >= 50 and not any("disk" in f["title"].lower() for f in findings):
        m = re.findall(r"ERROR \[[^\]]+\] (.+?)(?: for order \d+| \d+)", ev["tail_log"]["output"])
        top = max(set(m), key=m.count) if m else "see log"
        findings.append({"title": f"{errors} errors in the app log", "severity": "P3",
            "facts": [("count_errors", f"{errors} ERROR lines in orders.log."), ("tail_log", f"Most recent error pattern: '{top}'.")],
            "inference": "Errors point to a downstream dependency (payment gateway) rather than this host; host checks are normal." if app_up else "Errors accompany the outage above.",
            "recommendation": "Check payment gateway status and escalate to its owning team; no host action needed.",
            "action": None})

    summary = ("No problems found. The app is healthy and host resources are normal." if not findings
               else f"{len(findings)} problem(s) found. Most severe: {findings[0]['title']}.")
    return {"summary": summary, "healthy": healthy, "findings": findings,
            "evidence": {k: {"command": v.get("command"), "output": v["output"]} for k, v in ev.items()}}

def _mem_fact(ev):
    out = ev["container_memory"]["output"].split()
    if ev["container_memory"]["rc"] == 0 and len(out) == 2 and out[1].isdigit():
        used, lim = int(out[0]), int(out[1])
        return [("container_memory", f"Container memory {used//1048576} MB of {lim//1048576} MB limit ({used*100//lim}%).")]
    for line in ev["memory"]["output"].splitlines():
        p = line.split()
        if p and p[0] == "Mem:" and len(p) >= 3:
            return [("memory", f"Host memory: {p[2]} MB used of {p[1]} MB.")]
    return []

def _bytes(h):
    m = re.match(r"([\d.]+)([KMGT]?)", h)
    if not m: return 0
    return float(m.group(1)) * {"": 1, "K": 1e3, "M": 1e6, "G": 1e9, "T": 1e12}[m.group(2)]
