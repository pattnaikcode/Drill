"""The Runner: the only code that executes commands.

Rules (the same ones you would explain to a bank's security team):
1. Only checks from CHECKS can run. Nothing else, ever.
2. Arguments are validated against strict patterns.
3. Commands run as argument lists: no shell, so no ';', '&&' or '|' tricks.
4. Every run has a timeout, output is truncated and redacted.
5. Everything is audited. Changing actions live in ACTIONS and need a named approver.
"""
import re, shlex, subprocess
import audit
from config import APP_LOG_DIR, DATA_DIR
from redact import redact

MAX_OUT = 6000
ALLOWED_DIRS = (APP_LOG_DIR.rstrip("/") + "/", DATA_DIR.rstrip("/") + "/")
NAME = re.compile(r"^[A-Za-z0-9_.\-]{1,40}$")

def v_name(x):
    if not NAME.match(str(x)): raise ValueError(f"unsafe name {x!r}")
    return str(x)

def v_path(x):
    x = str(x)
    ok = (x + "/").startswith(ALLOWED_DIRS) or x.startswith(ALLOWED_DIRS)
    if ".." in x or not ok or not re.match(r"^[A-Za-z0-9_./\-]+$", x):
        raise ValueError(f"path {x!r} is outside approved directories {ALLOWED_DIRS}")
    return x

def v_lines(x):
    n = int(x)
    if not 5 <= n <= 300: raise ValueError("lines must be between 5 and 300")
    return str(n)

# name: (description, argv builder, {param: validator}, defaults)
CHECKS = {
    "disk_usage":     ("Filesystem usage (df -h)", lambda a: ["df", "-hP"], {}, {}),
    "memory":         ("Memory usage (free -m)", lambda a: ["free", "-m"], {}, {}),
    "container_memory": ("Container memory used vs limit (cgroup)", lambda a: ["cat", "/sys/fs/cgroup/memory.current", "/sys/fs/cgroup/memory.max"], {}, {}),
    "load":           ("Uptime and load average", lambda a: ["uptime"], {}, {}),
    "top_processes":  ("Top 10 processes by CPU", lambda a: ["ps", "-eo", "pid,pcpu,pmem,rss,etime,args", "--sort=-pcpu"], {}, {}),
    "process_running":("Is a process running (pgrep -af)", lambda a: ["pgrep", "-af", a["name"]], {"name": v_name}, {"name": "orders_app"}),
    "app_health":     ("HTTP health check of the orders app", lambda a: ["curl", "-s", "-m", "3", "-o", "/dev/null", "-w", "HTTP %{http_code} in %{time_total}s", "http://127.0.0.1:9000/health"], {}, {}),
    "tail_log":       ("Last N lines of a log in an approved directory", lambda a: ["tail", "-n", a["lines"], a["path"]], {"path": v_path, "lines": v_lines}, {"path": APP_LOG_DIR + "/orders.log", "lines": "40"}),
    "count_errors":   ("Count ERROR lines in the app log", lambda a: ["grep", "-c", "ERROR", a["path"]], {"path": v_path}, {"path": APP_LOG_DIR + "/orders.log"}),
    "largest_files":  ("Largest items in an approved directory (du)", lambda a: ["du", "-ah", "--max-depth=1", a["path"]], {"path": v_path}, {"path": DATA_DIR}),
}

# Typed commands are only accepted if they match one of these exactly.
ALIASES = {"df -h": "disk_usage", "df": "disk_usage", "free -m": "memory", "free": "memory", "uptime": "load",
           "ps": "top_processes", "top": "top_processes", "pgrep orders_app": "process_running"}

def _validate(spec, args):
    _, _, params, defaults = spec
    unknown = set(args) - set(params)
    if unknown: raise ValueError(f"unexpected arguments {sorted(unknown)}")
    merged = {**defaults, **{k: v for k, v in args.items() if v not in (None, "")}}
    return {k: params[k](merged[k]) for k in params}

def _exec(argv, timeout=10):
    try:
        p = subprocess.run(argv, capture_output=True, text=True, timeout=timeout, shell=False)
        out = (p.stdout + p.stderr).strip()
        return out or "(no output)", p.returncode
    except FileNotFoundError:
        return f"{argv[0]}: not available on this host", 127
    except subprocess.TimeoutExpired:
        return f"timed out after {timeout}s", 124

def run_check(name, args=None, actor="engineer"):
    args = args or {}
    if name not in CHECKS:
        audit.record("rejected", actor=actor, check=name, reason="not an approved check")
        return {"ok": False, "check": name, "output": f"REJECTED: '{name}' is not in the approved catalogue."}
    try:
        clean = _validate(CHECKS[name], args)
    except (ValueError, TypeError) as e:
        audit.record("rejected", actor=actor, check=name, reason=str(e))
        return {"ok": False, "check": name, "output": f"REJECTED: {e}"}
    argv = CHECKS[name][1](clean)
    out, rc = _exec(argv)
    if name == "top_processes":
        out = "\n".join(out.splitlines()[:11])
    out = redact(out)[:MAX_OUT]
    audit.record("check_run", actor=actor, check=name, args=clean, rc=rc)
    return {"ok": True, "check": name, "args": clean, "command": shlex.join(argv), "rc": rc, "output": out}

def run_typed(text, actor="engineer"):
    """A person typed a command. Accept it only if it maps exactly to an approved check."""
    t = " ".join(text.strip().split())
    if t in ALIASES:
        return run_check(ALIASES[t], {}, actor)
    audit.record("rejected", actor=actor, command=t[:200], reason="free-form commands are not allowed")
    return {"ok": False, "check": None, "command": t,
            "output": "REJECTED: free-form shell commands are never executed.\n"
                      "Pick an approved check instead. Allowed typed shortcuts: " + ", ".join(sorted(ALIASES))}

def catalogue():
    return [{"name": k, "description": v[0], "params": list(v[2]), "defaults": v[3]} for k, v in CHECKS.items()]
