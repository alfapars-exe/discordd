"""Review and atomically publish tracked application sources; never alter Space secrets or volumes."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time

from huggingface_hub import HfApi, CommitOperationAdd, CommitOperationDelete

from hf_source_manifest import MANIFEST, managed

FRONTEND_CONTRACTS = {p for p in MANIFEST["files"] if p.startswith("electron/")}


def record_deployed_commit(commit):
    # The verifier must target create_commit's exact result, not a possibly
    # stale HEAD response immediately after publication.
    output = os.environ.get("GITHUB_OUTPUT")
    if output:
        with open(output, "a", encoding="utf-8") as destination:
            destination.write(f"deployed_commit={commit}\n")


def stop_previous_backend(api, repo):
    # Older binaries do not hold the singleton lock. A rolling build could
    # otherwise serve both versions against the same PostgreSQL database.
    runtime = api.pause_space(repo)
    for _ in range(60):
        if runtime.stage == "PAUSED":
            return
        time.sleep(2)
        runtime = api.get_space_runtime(repo)
    raise SystemExit("Previous backend did not stop; no sources published")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--expected-head", default="", help="Reviewed Space commit; required when publishing")
    parser.add_argument("--publish", action="store_true")
    parser.add_argument("--reviewed-plan-sha256", default="")
    options = parser.parse_args()
    if options.publish and not options.expected_head:
        raise SystemExit("Publish requires a reviewed expected Space HEAD; nothing published")
    if not os.environ.get("HF_TOKEN"):
        raise SystemExit("HF_TOKEN is not configured; nothing published")
    api = HfApi()
    repo = "infinayazilim/discord"
    current = api.space_info(repo).sha
    if options.expected_head and current != options.expected_head:
        raise SystemExit("Space HEAD changed; review its new revision before publishing")
    source = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
    paths = subprocess.check_output(["git", "ls-files", "-z"]).decode().split("\0")
    local = {path: Path(path) for path in paths if managed(path)}
    remote = {entry.path: entry for entry in api.list_repo_tree(repo, repo_type="space", revision=current, recursive=True) if hasattr(entry, "blob_id") and managed(entry.path)}
    additions = []
    source_files = []
    for name, path in sorted(local.items()):
        if path.is_symlink():
            raise SystemExit("Symlink source refused; nothing published")
        data = path.read_bytes()
        if data.splitlines()[:1] == [b"version https://git-lfs.github.com/spec/v1"]:
            raise SystemExit("Unmaterialized LFS pointer; checkout LFS before publishing")
        source_files.append({"path": name, "size": len(data), "sha256": hashlib.sha256(data).hexdigest()})
        entry = remote.get(name)
        lfs = getattr(entry, "lfs", None)
        same = bool(entry and ((lfs and hashlib.sha256(data).hexdigest() == lfs.sha256) or (not lfs and hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest() == entry.blob_id)))
        if not same:
            # Bind the operation to the bytes that were reviewed. A later
            # filesystem edit cannot change the content sent by this command.
            additions.append(CommitOperationAdd(path_in_repo=name, path_or_fileobj=data))
    removals = sorted(set(remote) - set(local))
    plan = {"manifest_version": 2, "source_commit": source, "source_files": source_files, "space_parent": current, "add_or_update": [op.path_in_repo for op in additions], "remove_managed_source": removals, "hub_may_update_lfs_metadata": True}
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
    stop_previous_backend(api, repo)
    result = api.create_commit(repo, repo_type="space", parent_commit=current, operations=operations, commit_message=f"Deploy HiChat {source[:12]}")
    api.restart_space(repo)
    print(json.dumps({"status": "published", "commit": result.oid, "url": result.commit_url}))
    record_deployed_commit(result.oid)


if __name__ == "__main__":
    main()
