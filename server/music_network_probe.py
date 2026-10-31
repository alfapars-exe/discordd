"""Temporary fixed-target runtime diagnostics. No credentials or response bodies."""

import concurrent.futures
import contextlib
import importlib.metadata
import json
import os
import ssl
import subprocess
import sys
import urllib.request


def inventory():
    result = {
        "python": sys.version.split()[0],
        "openssl": ssl.OPENSSL_VERSION,
        "yt_dlp": "unavailable",
        "handlers": [],
        "packages": {},
        "proxy_present": bool(urllib.request.getproxies()),
    }
    for name in ("requests", "urllib3", "curl_cffi", "certifi"):
        try:
            result["packages"][name] = importlib.metadata.version(name)
        except Exception:
            result["packages"][name] = "unavailable"
    # Import the installed zipimport artifact, with import warnings discarded.
    with (open(os.devnull, "w") as sink,
          contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink)):
        try:
            sys.path.insert(0, "/usr/local/bin/yt-dlp")
            import yt_dlp.networking
            from yt_dlp.networking.common import _REQUEST_HANDLERS
            from yt_dlp.version import __version__

            result["yt_dlp"] = __version__
            result["handlers"] = sorted(_REQUEST_HANDLERS)
        except Exception:
            pass
    return result


def probe(item):
    target, url, family = item
    result = {"target": target, "family": family, "outcome": "unavailable", "exit_code": 0,
              "http_code": 0, "dns_ms": 0, "tcp_ms": 0, "tls_ms": 0, "total_ms": 0}
    args = ["/usr/bin/curl", "-q", "--silent", "--http1.1", "--connect-timeout", "5",
            "--max-time", "7", "--max-redirs", "0", "--output", os.devnull,
            "--write-out", "%{http_code} %{time_namelookup} %{time_connect} %{time_appconnect} %{time_total}"]
    if family == "ipv4":
        args.append("--ipv4")
    args.extend(["--url", url])
    try:
        completed = subprocess.run(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                   stderr=subprocess.DEVNULL, timeout=8, check=False)
        result["exit_code"] = completed.returncode if 0 <= completed.returncode <= 255 else 125
        fields = completed.stdout.decode("ascii").split()
        if len(fields) == 5:
            result["http_code"] = int(fields[0])
            for name, value in zip(("dns_ms", "tcp_ms", "tls_ms", "total_ms"), fields[1:]):
                result[name] = round(float(value) * 1000, 3)
        result["outcome"] = "complete"
    except subprocess.TimeoutExpired:
        result["outcome"] = "timeout"
    except Exception:
        pass
    return result


def main():
    report = {"inventory": inventory(), "probes": []}
    targets = (("youtube", "https://www.youtube.com/generate_204"),
               ("google", "https://www.google.com/generate_204"),
               ("huggingface", "https://huggingface.co/robots.txt"))
    items = [(name, url, family) for name, url in targets for family in ("default", "ipv4")]
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as executor:
        report["probes"] = list(executor.map(probe, items))
    print(json.dumps(report, allow_nan=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
