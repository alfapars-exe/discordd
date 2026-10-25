#!/usr/bin/env python3
"""Fail-closed exact-source review support for self-scan false positives.

This is only for the four narrowly reviewed self-scan rule families listed
below. It is not a Checkmarx suppression/acceptance record and cannot suppress
unlisted paths, rules, or changed source. CI and local runs use Python 3 from
PATH; Windows Git Bash users may set SELF_SCAN_PYTHON to the Python executable.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from pathlib import Path
from typing import Any

# The scanner review queue includes UTF-8 labels and may run under Windows
# Git Bash where Python otherwise inherits a legacy console code page.
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")


RULE_PATTERNS = {
    "js.innerhtml-assignment": re.compile(r"\.(innerHTML|outerHTML)\s*="),
    "js.webstorage-sensitive-key": re.compile(
        r"(localStorage|sessionStorage)\.setItem\([^)]*(session|token|user|auth|password)"
    ),
    "go.sql-sprintf": re.compile(
        r"\.(Query|QueryRow|Exec)(Context)?\([^)]*fmt\.Sprintf"
    ),
    "go.sql-concat": re.compile(
        r"\.(Query|QueryRow|Exec)(Context)?\([^)]*[A-Za-z_]+\s*\+"
    ),
    "go.weak-hash": re.compile(r'"crypto/(md5|sha1)"'),
}
ENTRY_KEYS = {"rule", "path", "file_sha256", "line_sha256", "reason", "proof_ref"}
MANIFEST_KEYS = {"version", "entries"}
HEX_256 = re.compile(r"^[0-9a-f]{64}$")


class ReviewedFPError(Exception):
    pass


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def canonical_source_bytes(data: bytes) -> bytes:
    """Make tracked-source hashes independent of Git checkout line endings."""
    return data.replace(b"\r\n", b"\n")


def source_digest(data: bytes) -> str:
    return sha256(canonical_source_bytes(data))


def line_digest(line: str) -> str:
    return sha256(line.strip().encode("utf-8"))


def load_manifest(path: Path) -> list[dict[str, Any]]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ReviewedFPError(f"cannot read reviewed-hit manifest: {exc}") from exc
    if not isinstance(payload, dict) or set(payload) != MANIFEST_KEYS or payload["version"] != 1:
        raise ReviewedFPError("malformed reviewed-hit manifest header")
    entries = payload["entries"]
    if not isinstance(entries, list):
        raise ReviewedFPError("manifest entries must be a list")
    seen: set[tuple[str, str, str]] = set()
    for index, entry in enumerate(entries):
        if not isinstance(entry, dict) or set(entry) != ENTRY_KEYS:
            raise ReviewedFPError(f"manifest entry {index} has missing or extra fields")
        if entry["rule"] not in RULE_PATTERNS:
            raise ReviewedFPError(f"manifest entry {index} uses an unreviewed rule")
        rel = entry["path"]
        if not isinstance(rel, str) or not rel or "\\" in rel:
            raise ReviewedFPError(f"manifest entry {index} has invalid repository path")
        pure = Path(rel)
        if pure.is_absolute() or any(part in ("", ".", "..") for part in pure.parts):
            raise ReviewedFPError(f"manifest entry {index} path must be normalized and relative")
        if not all(isinstance(entry[k], str) and entry[k].strip() for k in ("reason", "proof_ref")):
            raise ReviewedFPError(f"manifest entry {index} requires reason and proof_ref")
        if not HEX_256.fullmatch(str(entry["file_sha256"])) or not HEX_256.fullmatch(
            str(entry["line_sha256"])
        ):
            raise ReviewedFPError(f"manifest entry {index} has malformed SHA-256")
        identity = (entry["rule"], rel, entry["line_sha256"])
        if identity in seen:
            raise ReviewedFPError(f"duplicate manifest entry {index}")
        seen.add(identity)
    return entries


def resolve_reviewed_source(root: Path, rel: str) -> Path:
    root = root.resolve(strict=True)
    source = (root / Path(rel)).resolve(strict=True)
    try:
        source.relative_to(root)
    except ValueError as exc:
        raise ReviewedFPError(f"manifest path escapes source root: {rel}") from exc
    if not source.is_file():
        raise ReviewedFPError(f"manifest path is not a file: {rel}")
    return source


def validate_entries(root: Path, entries: list[dict[str, Any]]) -> None:
    for index, entry in enumerate(entries):
        source = resolve_reviewed_source(root, entry["path"])
        data = source.read_bytes()
        if source_digest(data) != entry["file_sha256"]:
            raise ReviewedFPError(f"stale source hash in entry {index}: {entry['path']}")
        try:
            lines = data.decode("utf-8").splitlines()
        except UnicodeDecodeError as exc:
            raise ReviewedFPError(f"reviewed source is not UTF-8: {entry['path']}") from exc
        pattern = RULE_PATTERNS[entry["rule"]]
        matching = [line for line in lines if line_digest(line) == entry["line_sha256"]]
        if not matching or not any(pattern.search(line) for line in matching):
            raise ReviewedFPError(f"stale or nonmatching line hash in entry {index}: {entry['path']}")


def parse_grep_hit(raw: str) -> tuple[str, int, str]:
    match = re.match(r"^(.*?):(\d+):(.*)$", raw)
    if not match:
        raise ReviewedFPError("unparseable grep hit")
    return match.group(1), int(match.group(2)), match.group(3)


def rel_source_path(root: Path, raw_path: str) -> str:
    root = root.resolve(strict=True)
    candidate = Path(raw_path)
    if not candidate.is_absolute():
        candidate = Path.cwd() / candidate
    candidate = candidate.resolve(strict=True)
    try:
        return candidate.relative_to(root).as_posix()
    except ValueError as exc:
        raise ReviewedFPError(f"scan hit outside source root: {raw_path}") from exc


def validate_command(args: argparse.Namespace) -> int:
    try:
        entries = load_manifest(args.manifest)
        validate_entries(args.root, entries)
    except (ReviewedFPError, OSError) as exc:
        print(f"reviewed-hit manifest rejected: {exc}", file=sys.stderr)
        return 1
    print(f"reviewed-hit manifest valid ({len(entries)} exact source records)")
    return 0


def filter_command(args: argparse.Namespace) -> int:
    if args.rule not in RULE_PATTERNS:
        print(f"unreviewed self-scan rule: {args.rule}", file=sys.stderr)
        return 1
    try:
        entries = load_manifest(args.manifest)
        validate_entries(args.root, entries)
    except (ReviewedFPError, OSError) as exc:
        print(f"reviewed-hit manifest rejected: {exc}", file=sys.stderr)
        return 1
    index = {
        (entry["rule"], entry["path"], entry["line_sha256"]): entry
        for entry in entries
    }
    unreviewed = False
    for raw in sys.stdin:
        raw = raw.rstrip("\r\n")
        if not raw:
            continue
        try:
            hit_path, _line_number, content = parse_grep_hit(raw)
            rel = rel_source_path(args.root, hit_path)
            line_hash = line_digest(content)
            entry = index.get((args.rule, rel, line_hash))
            if entry is None or not RULE_PATTERNS[args.rule].search(content):
                print(raw)
                unreviewed = True
                continue
            print(
                f"🔎 INCELEME [reviewed self-scan FP:{args.rule}; proof={entry['proof_ref']}]: {raw}"
            )
        except (ReviewedFPError, OSError) as exc:
            print(raw)
            print(f"reviewed-hit validation failed: {exc}", file=sys.stderr)
            unreviewed = True
    return 1 if unreviewed else 0


def main() -> int:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    validate_parser = sub.add_parser("validate")
    validate_parser.add_argument("--root", type=Path, required=True)
    validate_parser.add_argument("--manifest", type=Path, required=True)
    validate_parser.set_defaults(func=validate_command)
    filter_parser = sub.add_parser("filter")
    filter_parser.add_argument("--root", type=Path, required=True)
    filter_parser.add_argument("--manifest", type=Path, required=True)
    filter_parser.add_argument("--rule", required=True)
    filter_parser.set_defaults(func=filter_command)
    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
