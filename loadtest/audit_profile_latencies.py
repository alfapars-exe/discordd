"""Audit bounded synthetic Go profile benchmark logs, excluding calibration rows."""
import argparse
import hashlib
import json
from pathlib import Path
import re
from decimal import Decimal
import statistics

SAMPLES = re.compile(r"operationLatenciesNs=\[([0-9 ]+)\]")
RESULT = re.compile(
    r"^BenchmarkGroupPublicProfilePopulation/(users=(?:0|1|100|1001)/bulk=(?:true|false))-\d+"
    r"\s+(\d+)\s+[0-9.eE+-]+ ns/op\s+([0-9.eE+-]+) p50-ns/op"
    r"\s+([0-9.eE+-]+) p95-ns/op\s+([0-9.eE+-]+) pool-wait-ns/op$")


def audit(text):
    groups = {}
    pending = None
    for line in text.splitlines():
        match = SAMPLES.search(line)
        if match:
            pending = [int(value) for value in match[1].split()]
        result = RESULT.fullmatch(line.strip())
        if not result:
            continue
        name, row = measurement(result, pending)
        groups.setdefault(name, []).append(row)
        pending = None
    require_complete_capture(text, groups)
    return {"result": "PASS", "cases": groups,
            "repetitionSummaries": {name: summarize_repetitions(rows) for name, rows in groups.items()},
            "scope": "Recorded sequential repository operation percentiles only; calibration excluded. Not HTTP latency, concurrent pool budgets, source provenance or full RF acceptance."}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("log", type=Path)
    args = parser.parse_args()
    # Bound reads before decoding; logs can contain unrelated fixture setup text.
    with args.log.open("rb") as stream:
        data = stream.read(16 * 1024 * 1024 + 1)
    if len(data) > 16 * 1024 * 1024:
        raise ValueError("Benchmark log exceeds16MiB")
    result = audit(data.decode("utf-8-sig"))
    result["logSha256"] = hashlib.sha256(data).hexdigest()
    print(json.dumps(result, indent=2))


def measurement(result, pending):
    name, count, p50, p95, wait = result.groups()
    if int(count) != 30 or pending is None or len(pending) != 30:
        raise ValueError("Expected thirty raw operation durations")
    if any(value > 2**63 - 1 for value in pending):
        raise ValueError("Duration exceeds Go time.Duration range")
    ordered = sorted(pending)
    if Decimal(p50) != ordered[14] or Decimal(p95) != ordered[28]:
        raise ValueError("Reported nearest-rank percentiles differ from raw samples")
    pool_wait = Decimal(wait)
    if not pool_wait.is_finite() or pool_wait < 0:
        raise ValueError("Invalid pool wait metric")
    return name, {"operationLatenciesNs": pending, "p50Ns": ordered[14], "p95Ns": ordered[28],
                  "poolWaitNsPerOperation": wait}


def require_complete_capture(text, groups):
    expected = {f"users={size}/bulk={bulk}" for size in (0, 1, 100, 1001) for bulk in ("false", "true")}
    if set(groups) != expected or any(len(rows) != 9 for rows in groups.values()):
        raise ValueError("Expected eight cases with nine measured repetitions each")
    if "PASS" not in text.splitlines() or any(line.startswith("FAIL") or "--- FAIL:" in line for line in text.splitlines()):
        raise ValueError("Benchmark run did not pass")


def summarize_repetitions(rows):
    values = [row["p95Ns"] for row in rows]
    mean = statistics.mean(values)
    return {
        "repetitions": len(values),
        "p95AcrossRepetitionsNs": {"min": min(values), "median": statistics.median(values), "max": max(values)},
        "p95SampleCoefficientOfVariation": None if mean == 0 else statistics.stdev(values) / mean,
        "scope": "Descriptive variation of nine per-repetition p95 estimates, not pooled p95, a confidence interval, cross-host variation or a latency budget.",
    }


if __name__ == "__main__":
    main()
