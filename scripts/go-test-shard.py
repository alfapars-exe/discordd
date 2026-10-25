#!/usr/bin/env python3
"""Run a balanced Go test shard, including examples and fuzz seed cases."""

from __future__ import annotations

import argparse
import hashlib
import re
import subprocess
import sys


def parse_test_names(output: str) -> list[str]:
    return [
        line.strip()
        for line in output.splitlines()
        if re.fullmatch(r"(?:Test|Example|Fuzz)\w*", line.strip())
    ]


def discover_tests(package: str) -> list[str]:
    result = subprocess.run(
        ["go", "test", "-list", "^(Test|Example|Fuzz)", package],
        check=False,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if result.returncode:
        sys.stderr.write(result.stderr)
        raise SystemExit(result.returncode)
    tests = parse_test_names(result.stdout)
    if not tests:
        raise SystemExit(f"no Test* functions discovered in {package}")
    if len(tests) != len(set(tests)):
        raise SystemExit(f"duplicate Test* names discovered in {package}")
    return tests


def partition(tests: list[str], shard_count: int) -> list[list[str]]:
    """Hash-order and round-robin tests, keeping shard counts within one."""
    if shard_count < 1:
        raise ValueError("shard_count must be positive")
    ordered = sorted(tests, key=lambda name: (hashlib.sha256(name.encode("utf-8")).digest(), name))
    shards = [[] for _ in range(shard_count)]
    for position, name in enumerate(ordered):
        shards[position % shard_count].append(name)
    return shards


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--package", required=True, help="one Go package pattern, for example ./services")
    parser.add_argument("--shards", required=True, type=int)
    parser.add_argument("--shard", required=True, type=int, help="zero-based shard index")
    args = parser.parse_args()
    if args.shards < 1 or not 0 <= args.shard < args.shards:
        parser.error("require --shards >= 1 and 0 <= --shard < --shards")

    tests = discover_tests(args.package)
    shards = partition(tests, args.shards)
    selected = shards[args.shard]
    if not selected:
        raise SystemExit(f"shard {args.shard}/{args.shards} is empty for {len(tests)} tests")

    print(f"{args.package}: shard {args.shard + 1}/{args.shards}, {len(selected)}/{len(tests)} tests", flush=True)
    for name in selected:
        print(f"  {name}", flush=True)
    run_pattern = "^(" + "|".join(re.escape(name) for name in selected) + ")$"
    command = ["go", "test", "-race", "-cover", "-timeout=15m", "-run", run_pattern, args.package]
    return subprocess.run(command, check=False).returncode


if __name__ == "__main__":
    raise SystemExit(main())
