"""Append-only audit trail. Every check, rejection, fault, approval and action is recorded."""
import json, os, threading, time
from config import AUDIT_LOG
_lock = threading.Lock()
os.makedirs(os.path.dirname(AUDIT_LOG), exist_ok=True)

def record(event, **details):
    entry = {"ts": time.strftime("%H:%M:%S"), "event": event, **details}
    with _lock, open(AUDIT_LOG, "a") as f:
        f.write(json.dumps(entry) + "\n")

def recent(n=60):
    try:
        with open(AUDIT_LOG) as f:
            lines = f.readlines()[-n:]
        return [json.loads(l) for l in reversed(lines)]
    except FileNotFoundError:
        return []
