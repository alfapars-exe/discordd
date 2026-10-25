"""Review and atomically publish tracked application sources; never alter Space secrets or volumes."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess

from huggingface_hub import HfApi, CommitOperationAdd, CommitOperationDelete

FRONTEND_CONTRACTS = {"electron/voice-overlay-contract.ts", "electron/overlay-media-contract.ts", "electron/cs2-join-contract.ts"}
ROOT_FILES = {"Dockerfile", ".dockerignore", "README.md", "package.json", "package-lock.json"} | FRONTEND_CONTRACTS


def managed(path):
    return path in ROOT_FILES or path.startswith(("client/", "server/"))


def record_deployed_commit(commit):
    # The verifier must target create_commit's exact result, not a possibly
    # stale HEAD response immediately after publication.
    output = os.environ.get("GITHUB_OUTPUT")
    if output:
        with open(output, "a", encoding="utf-8") as destination:
            destination.write(f"deployed_commit={commit}\n")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--expected-head", required=True)
    parser.add_argument("--publish", action="store_true")
    parser.add_argument("--reviewed-plan-sha256", default="")
    options = parser.parse_args()
    if not os.environ.get("HF_TOKEN"):
        raise SystemExit("HF_TOKEN is not configured; nothing published")
    api = HfApi()
    repo = "infinayazilim/discord"
    current = api.space_info(repo).sha
    if current != options.expected_head:
        raise SystemExit("Space HEAD changed; review its new revision before publishing")
    source = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
    paths = subprocess.check_output(["git", "ls-files", "-z"]).decode().split("\0")
    local = {path: Path(path) for path in paths if managed(path)}
    remote = {entry.path: entry for entry in api.list_repo_tree(repo, repo_type="space", revision=current, recursive=True) if hasattr(entry, "blob_id") and managed(entry.path)}
    additions = []
    for name, path in sorted(local.items()):
        if path.is_symlink():
            raise SystemExit("Symlink source refused; nothing published")
        data = path.read_bytes()
        if data.startswith(b"version https://git-lfs.github.com/spec/v1\n"):
            raise SystemExit("Unmaterialized LFS pointer; checkout LFS before publishing")
        entry = remote.get(name)
        lfs = getattr(entry, "lfs", None)
        same = bool(entry and ((lfs and hashlib.sha256(data).hexdigest() == lfs.sha256) or (not lfs and hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest() == entry.blob_id)))
        if not same:
            additions.append(CommitOperationAdd(path_in_repo=name, path_or_fileobj=path))
    removals = sorted(set(remote) - set(local))
    plan = {"source_commit": source, "space_parent": current, "add_or_update": [op.path_in_repo for op in additions], "remove_managed_source": removals, "hub_may_update_lfs_metadata": True}
    plan_hash = hashlib.sha256(json.dumps(plan, sort_keys=True).encode()).hexdigest()
    print(json.dumps(plan, indent=2))
    print(json.dumps({"plan_sha256": plan_hash}))
    if not options.publish:
        return
    if options.reviewed_plan_sha256 != plan_hash:
        raise SystemExit("Publish requires the exact previously reviewed preview plan SHA-256; nothing published")
    operations = additions + [CommitOperationDelete(path_in_repo=path) for path in removals]
    if not operations:
        print(json.dumps({"status": "already_current", "commit": current}))
        record_deployed_commit(current)
        return
    result = api.create_commit(repo, repo_type="space", parent_commit=current, operations=operations, commit_message=f"Deploy HiChat {source[:12]}")
    print(json.dumps({"status": "published", "commit": result.oid, "url": result.commit_url}))
    record_deployed_commit(result.oid)


if __name__ == "__main__":
    main()
