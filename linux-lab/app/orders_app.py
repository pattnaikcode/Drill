"""A tiny fake 'Order Management' service so the lab has something real to break.
It accepts an order every 2 seconds, saves a receipt to the data disk and logs the result.
If the disk is full, saving fails and the app logs real 'No space left on device' errors."""
import json, os, random, threading, time
from http.server import BaseHTTPRequestHandler, HTTPServer
from config import APP_LOG, APP_LOG_DIR, DATA_DIR, APP_PORT

os.makedirs(APP_LOG_DIR, exist_ok=True)
RECEIPTS = os.path.join(DATA_DIR, "orders")
os.makedirs(RECEIPTS, exist_ok=True)
state = {"last_ok": True, "n": 1000}

def log(level, msg):
    with open(APP_LOG, "a") as f:
        f.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {level:5} [orders-app] {msg}\n")

def worker():
    while True:
        state["n"] += 1
        n, t0 = state["n"], time.time()
        try:
            jp = os.path.join(RECEIPTS, "journal.log")
            if os.path.exists(jp) and os.path.getsize(jp) > 10 * 1048576:
                os.replace(jp, jp + ".1")
            with open(jp, "a") as j:   # grows; fails when disk is full
                j.write(f"{time.time():.0f} order={n} " + "-" * 4096 + "\n"); j.flush(); os.fsync(j.fileno())
            with open(os.path.join(RECEIPTS, f"order-{n % 200}.json"), "w") as f:
                f.write(json.dumps({"order": n, "client": random.choice(["ABC-BANK", "MERIDIAN", "EASTLINE"]), "pad": "x" * 2048}))
            state["last_ok"] = True
            log("INFO", f"Order {n} accepted in {int((time.time()-t0)*1000) + random.randint(80, 160)}ms")
        except OSError as e:
            state["last_ok"] = False
            log("ERROR", f"Failed to persist order {n}: {e}")
        time.sleep(2)

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        code = 200 if self.path == "/health" and state["last_ok"] else 503 if self.path == "/health" else 404
        self.send_response(code); self.end_headers()
        self.wfile.write(b"OK" if code == 200 else b"DEGRADED")
    def log_message(self, *a):
        pass

if __name__ == "__main__":
    log("INFO", "orders-app started")
    threading.Thread(target=worker, daemon=True).start()
    HTTPServer(("127.0.0.1", APP_PORT), Handler).serve_forever()
