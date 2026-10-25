#!/usr/bin/env python3
"""Run a balanced Go test shard, including examples and fuzz seed cases."""

from __future__ import annotations

import argparse
import hashlib
import re
import subprocess
import sys
from pathlib import Path


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
    parser.add_argument("--coverprofile", help="unique coverage output for this shard")
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
    if args.coverprofile:
        Path(args.coverprofile).parent.mkdir(parents=True, exist_ok=True)
        command.extend(["-covermode=atomic", "-coverprofile=" + args.coverprofile])
    code = subprocess.run(command, check=False).returncode
    if code == 0 and args.coverprofile:
        code = subprocess.run([sys.executable, str(Path(__file__).with_name("coverage-meta.py")), args.coverprofile], check=False).returncode
    return code


if __name__ == "__main__":
    raise SystemExit(main())
