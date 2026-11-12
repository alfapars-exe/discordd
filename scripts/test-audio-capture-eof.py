"""Run on Windows with process-loopback capture available; no audio is stored."""
from concurrent.futures import ThreadPoolExecutor
import os
import struct
import subprocess
import sys


def read_stream(stream, started):
    header = stream.read(12)
    if len(header) != 12:
        raise RuntimeError("Audio helper closed before the format header")
    started.set_result(struct.unpack("<IHHI", header))
    while stream.read(8192):
        pass


def check_shutdown(helper):
    from concurrent.futures import Future
    started = Future()
    with subprocess.Popen([helper, str(os.getpid())], stdin=subprocess.PIPE,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE) as child:
        with ThreadPoolExecutor(max_workers=1) as pool:
            reader = pool.submit(read_stream, child.stdout, started)
            try:
                sample_rate, channels, bits, tag = started.result(timeout=10)
                if min(sample_rate, channels, bits) <= 0 or tag not in (1, 3):
                    raise RuntimeError("Invalid loopback format header")
                child.stdin.close()
                if child.wait(timeout=3) != 0:
                    raise RuntimeError("Unclean shutdown after stdin EOF")
                print(f"{sample_rate} Hz, {channels} channels, {bits} bits, format {tag}")
            finally:
                child.kill()
            reader.result(timeout=3)


if __name__ == "__main__":
    for _ in range(5):
        check_shutdown(sys.argv[1])
