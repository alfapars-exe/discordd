"""Shared source boundary for publishing and restoring a Space revision."""
import json
from pathlib import Path, PurePosixPath
import subprocess

MANIFEST = json.loads(Path(__file__).with_name("hf-source-manifest.json").read_text())


def managed(path, *, rollback=False):
    parts = PurePosixPath(path).parts
    if not path or path.startswith("/") or "\\" in path or any(p in ("..", ".") for p in path.split("/")):
        return False
    # Application source directories must never turn into a secret/data channel.
    if any(p == ".env" or p.startswith(".env.") and p not in (".env.example", ".env.sample") for p in parts):
        return False
    return (path in MANIFEST["files"] or
            any(path.startswith(prefix) for prefix in MANIFEST["directories"]) or
            rollback and path in MANIFEST["hub_metadata"])


def validate_rollback(repo, expected, restore):
    def git(*args):
        return subprocess.check_output(["git", "-C", str(repo), *args]).decode().strip()
    if git("rev-parse", "HEAD") != expected or git("rev-parse", "HEAD^") != restore:
        raise ValueError("Rollback must target the reviewed HEAD and its immediate parent")
    changed = git("diff", "--name-only", "-z", restore, expected).split("\0")
    changed = [p for p in changed if p]
    if not changed or any(not managed(p, rollback=True) for p in changed):
        raise ValueError("Refusing rollback: last change is not application-source-only")
    return changed
