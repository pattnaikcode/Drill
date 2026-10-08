"""Lab fault: grows memory to ~350 MB in steps and holds it for 3 minutes (simulates a leak)."""
import time
hog = []
for _ in range(35):
    hog.append(bytearray(10 * 1024 * 1024))
    time.sleep(0.2)
time.sleep(180)
