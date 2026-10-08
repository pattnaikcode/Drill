"""Chaos controls. These exist ONLY in the lab to create real problems to investigate.
They are deliberately separate from the runner: OpsPilot itself can never call them."""
import os, shutil, signal, subprocess, sys, time
import audit
from config import APP_LOG, DATA_DIR, MAX_FAULT_DISK_MB

HERE = os.path.dirname(os.path.abspath(__file__))
FILL_DIR = os.path.join(DATA_DIR, "archive")

def _pids(pattern):
    r = subprocess.run(["pgrep", "-f", pattern], capture_output=True, text=True)
    return [int(p) for p in r.stdout.split() if int(p) != os.getpid()]

def _spawn(script):
    subprocess.Popen([sys.executable, os.path.join(HERE, script)], cwd=HERE,
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)

def disk_fill():
    st = os.statvfs(DATA_DIR)
    total_mb = st.f_blocks * st.f_frsize / 1048576
    if total_mb > MAX_FAULT_DISK_MB:
        return f"Refused: {DATA_DIR} is {total_mb:.0f} MB. The disk fault only runs on the lab's small dedicated disk (run the lab with Docker)."
    os.makedirs(FILL_DIR, exist_ok=True)
    free = st.f_bavail * st.f_frsize
    chunk = b"\0" * (1024 * 1024)
    with open(os.path.join(FILL_DIR, "archive-2026-09.tar"), "ab") as f:
        try:
            for _ in range(int(free / len(chunk)) + 2):
                f.write(chunk)
        except OSError:
            pass
    return f"Filled {DATA_DIR}. The orders app will now fail to save orders."

def app_crash():
    pids = _pids("[o]rders_app.py")
    for p in pids:
        os.kill(p, signal.SIGKILL)
    return f"Killed orders app ({len(pids)} process)." if pids else "Orders app was not running."

def cpu_spike():
    _spawn("cpu_burn.py"); return "Started a runaway CPU process for 3 minutes."

def mem_leak():
    _spawn("mem_leak.py"); return "Started a process that leaks ~350 MB of memory."

def error_flood():
    with open(APP_LOG, "a") as f:
        for i in range(300):
            f.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} ERROR [orders-app] Payment gateway timeout for order {20000+i} after 30000ms\n")
    return "Wrote 300 payment-gateway timeout errors to the app log."

FAULTS = {"disk_fill": disk_fill, "app_crash": app_crash, "cpu_spike": cpu_spike, "mem_leak": mem_leak, "error_flood": error_flood}

def inject(name):
    if name not in FAULTS:
        return f"Unknown fault {name}"
    msg = FAULTS[name]()
    audit.record("fault_injected", actor="lab", fault=name, detail=msg)
    return msg

def start_app():
    if not _pids("[o]rders_app.py"):
        _spawn("orders_app.py"); return True
    return False

def reset():
    for pat in ("[c]pu_burn.py", "[m]em_leak.py"):
        for p in _pids(pat):
            os.kill(p, signal.SIGKILL)
    shutil.rmtree(FILL_DIR, ignore_errors=True)
    open(APP_LOG, "w").close()
    start_app()
    audit.record("lab_reset", actor="lab")
    return "Lab reset: faults cleared, log truncated, app running."
