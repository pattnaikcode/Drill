"""Actions CHANGE the system, so they are never run by the AI. The investigation can only
PROPOSE one. A named person must approve it and confirm, and both are audited."""
import os, shutil, signal
import audit, faults
from config import DATA_DIR

KILLABLE = ("cpu_burn.py", "mem_leak.py")   # in production: an approved list of process names

def restart_app(args):
    started = faults.start_app()
    return "Orders app started." if started else "Orders app was already running."

def clear_archive_files(args):
    path = faults.FILL_DIR
    size = sum(os.path.getsize(os.path.join(path, f)) for f in os.listdir(path)) if os.path.isdir(path) else 0
    shutil.rmtree(path, ignore_errors=True)
    return f"Removed archive files from {path} ({size/1048576:.0f} MB freed)."

def stop_runaway_process(args):
    pid = int(args.get("pid", 0))
    try:
        with open(f"/proc/{pid}/cmdline") as f:
            cmd = f.read().replace("\0", " ")
    except FileNotFoundError:
        return f"Process {pid} no longer exists."
    if not any(k in cmd for k in KILLABLE):
        raise PermissionError(f"Process {pid} ({cmd.strip()[:60]}) is not on the approved list of stoppable processes.")
    os.kill(pid, signal.SIGTERM)
    return f"Stopped process {pid} ({cmd.strip()[:60]})."

ACTIONS = {
    "restart_app": ("Start the orders app if it is not running", restart_app),
    "clear_archive_files": ("Delete archive files filling the data disk", clear_archive_files),
    "stop_runaway_process": ("Stop an approved runaway process by PID", stop_runaway_process),
}

def execute(name, args, approver, confirmed):
    if name not in ACTIONS:
        audit.record("action_rejected", action=name, reason="unknown action"); raise ValueError("Unknown action")
    if not approver or not confirmed:
        audit.record("action_rejected", action=name, reason="missing approver or confirmation")
        raise PermissionError("A named approver and explicit confirmation are required.")
    try:
        msg = ACTIONS[name][1](args or {})
    except PermissionError as e:
        audit.record("action_rejected", action=name, approver=approver, reason=str(e)); raise
    audit.record("action_executed", action=name, args=args, approver=approver, result=msg)
    return msg
