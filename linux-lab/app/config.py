"""Lab settings. Paths can be overridden with environment variables so the lab
also runs outside Docker (for testing)."""
import os
APP_LOG_DIR = os.environ.get("LAB_LOG_DIR", "/opt/app/logs")
APP_LOG = os.path.join(APP_LOG_DIR, "orders.log")
DATA_DIR = os.environ.get("LAB_DATA_DIR", "/data")          # small dedicated disk inside the lab
AUDIT_LOG = os.environ.get("LAB_AUDIT", "/opt/opspilot/audit.jsonl")
APP_PORT = int(os.environ.get("LAB_APP_PORT", "9000"))
MAX_FAULT_DISK_MB = 200   # refuse the disk fault unless DATA_DIR is a small, dedicated disk
