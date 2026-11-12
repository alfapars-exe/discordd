"""Exercise the shipped Windows foreground-window helper without requiring a visible window."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import json
import subprocess
import sys

resources = Path(__file__).resolve().parents[1] / "release/win-unpacked/resources/native"
helper = resources / "game-window.exe"
for pid in ("-1", "4294967296", "+1", " 123", "0"):
    result = subprocess.run([helper, "--watch", "--parent-pid", pid], capture_output=True, timeout=5)
    if result.returncode != 2 or result.stdout:
        raise RuntimeError(f"Helper accepted malformed PID {pid!r}")

for _ in range(5):
    with subprocess.Popen([sys.executable, "-c", "import sys; sys.stdin.read()"], stdin=subprocess.PIPE) as parent:
        child = subprocess.Popen([helper, "--watch", "--parent-pid", str(parent.pid)], stdout=subprocess.PIPE)
        try:
            # A bounded read prevents a stalled helper from hanging the packaging job.
            with ThreadPoolExecutor(max_workers=1) as reader:
                try:
                    line = reader.submit(child.stdout.readline).result(timeout=5)
                finally:
                    parent.communicate(timeout=5)
                    try:
                        child.wait(timeout=5)
                    finally:
                        if child.poll() is None:
                            child.kill()
            sample = json.loads(line)
            if child.returncode != 0 or sample["version"] != 1 or type(sample["available"]) is not bool:
                raise RuntimeError("Unexpected sample or exit status after parent shutdown")
        finally:
            child.kill()
            child.communicate(timeout=5)

for args in ([], ["0"], ["-1"], ["42suffix"], ["4294967296"], ["1", "2"]):
    result = subprocess.run([resources / "audio-capture.exe", *args], capture_output=True, timeout=5)
    if result.returncode != 1 or result.stdout or not result.stderr.startswith(b"Usage:"):
        raise RuntimeError(f"Audio helper did not reject arguments {args!r}")
