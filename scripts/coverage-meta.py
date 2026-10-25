"""Bind a Go coverage profile to its actual source tree and revision."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys


def source_identity(root):
    names = subprocess.check_output(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z", "server"], cwd=root).decode().split("\0")
    sources = []
    for name in sorted(set(names)):
        if name.endswith((".go", "go.mod", "go.sum")) and (root / name).is_file():
            sources.append([name, hashlib.sha256((root / name).read_bytes()).hexdigest()])
    return {
        "revision": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip(),
        "source_sha256": hashlib.sha256(json.dumps(sources).encode()).hexdigest(),
    }


if __name__ == "__main__":
    profile = Path(sys.argv[1])
    if not profile.is_file():
        raise SystemExit("Coverage profile is missing")
    identity = source_identity(Path(__file__).resolve().parents[1])
    identity["profile_sha256"] = hashlib.sha256(profile.read_bytes()).hexdigest()
    Path(str(profile) + ".meta.json").write_text(json.dumps(identity) + "\n", encoding="utf-8")
