"""Lab fault: busy loop for 3 minutes (simulates a runaway process)."""
import time
end = time.time() + 180
while time.time() < end:
    pass
