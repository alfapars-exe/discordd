"""Independently audit the fixed local fan-out profile without trusting its verdict.

Only the standard library is required. Docker/process absence and physical media
are outside this offline audit; the launcher cleanup record is checked as a record.
"""

import argparse
import hashlib
import json
import re
import sys
from datetime import datetime
from pathlib import Path


class AuditError(ValueError):
    pass


def require(condition, message):
    # Do not use assert: python -O must never disable an acceptance gate.
    if not condition:
        raise AuditError(message)


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def audit_sources(fixture, snapshot):
    source = fixture / "source"
    actual = {}

    def refuse_link(path):
        require(not path.is_symlink() and not getattr(path, "is_junction", lambda: False)(),
                "Source contains a filesystem link")

    def visit(path):
        refuse_link(path)
        if path.is_dir():
            for child in sorted(path.iterdir()):
                visit(child)
        else:
            require(path.is_file(), "Source is not a regular file")
            actual[path.relative_to(source).as_posix()] = sha256(path)

    for parent in [source, source / "e2e", source / "e2e/scripts"]:
        refuse_link(parent)
    for name in ["server", "e2e/scripts/pg-fixture.go", "loadtest"]:
        visit(source / name)
    require(actual == snapshot["files"] and bool(actual), "Archived source hashes differ")
    encoded = json.dumps(snapshot["files"], ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    require(hashlib.sha256(encoded).hexdigest() == snapshot["sha256"], "Source manifest digest differs")
    return len(actual)


def audit_history(fixture, fanout):
    users = fanout["userIds"]
    require(isinstance(users, list) and len(users) == 20 and len(set(users)) == 20,
            "Expected twenty distinct healthy users")
    require(all(isinstance(user, str) and user for user in users), "Invalid healthy user ID")
    require(fanout["messagesPerSender"] == 290, "Unexpected message count per sender")
    paths = list((fixture / "history-pages").glob("*.json"))
    require({path.name for path in paths} == {f"{i}.json" for i in range(1, 59)},
            "Expected exactly fifty-eight history pages")
    ids, slots, positions, canonical, page_hashes = set(), set(), set(), [], {}
    previous_oldest, before = None, ""
    for index in range(1, 59):
        path = fixture / "history-pages" / f"{index}.json"
        data = path.read_bytes()
        page = json.loads(data.decode("utf-8-sig"))
        page_hashes[path.name] = hashlib.sha256(data).hexdigest()
        rows = page["messages"]
        require(page["before"] == before and page["limit"] == 100 and len(rows) == 100,
                "History cursor or page size differs")
        require(page["has_more"] is (index < 58) and page["has_more_after"] is False,
                "Unexpected history pagination flags")
        sequence = [row["source_sequence"] for row in rows]
        require(all(type(value) is int and 0 < value < 2**53 for value in sequence),
                "Missing or unsafe PostgreSQL source position")
        require(all(a < b for a, b in zip(sequence, sequence[1:])), "History page order differs")
        require(previous_oldest is None or max(sequence) < previous_oldest,
                "History pages overlap or reverse direction")
        previous_oldest, before = min(sequence), rows[0]["id"]
        for row in rows:
            require(row["channel_id"] == fanout["channel"] and row["user_id"] in users,
                    "Foreign message actor or channel")
            payload = json.loads(row["content"])
            value = payload["sequence"]
            require(payload["probe"] == fanout["probeId"] and payload["sender"] == row["user_id"]
                    and type(value) is int and 1 <= value <= 290, "Foreign or malformed probe message")
            identity, slot, position = row["id"], (row["user_id"], value), row["source_sequence"]
            require(isinstance(identity, str) and bool(identity), "Invalid persisted message ID")
            require(identity not in ids and slot not in slots and position not in positions,
                    "Duplicate persisted message, sender slot or source position")
            ids.add(identity)
            slots.add(slot)
            positions.add(position)
            canonical.append([row["user_id"], value, identity])
    require(len(canonical) == 5800, "Incomplete persisted message history")
    ranks = {user: index for index, user in enumerate(users)}
    canonical.sort(key=lambda row: (ranks[row[0]], row[1]))
    digest = hashlib.sha256(json.dumps(canonical, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
    result = fanout["result"]
    require(all(result[key] == expected for key, expected in {
        "sent": 5800, "received": 116000, "receivers": 20, "duplicates": 0,
        "invalid": 0, "persisted": 5800, "historyPages": 58, "digest": digest,
    }.items()), "Reported fan-out counters or digest differ from history")
    receipts = result["receipts"]
    require(len(receipts) == 20 and {receipt["receiver"] for receipt in receipts} == set(users),
            "Missing or duplicate healthy receiver receipt")
    for receipt in receipts:
        require(receipt["summary"]["complete"] is True and receipt["digest"] == digest,
                "Receiver did not complete the persisted digest")
        own = {value: identity for user, value, identity in canonical if user == receipt["receiver"]}
        acknowledgements = receipt["acknowledged"]
        require(len(acknowledgements) == 290 and all(isinstance(pair, list) and len(pair) == 2
                and type(pair[0]) is int and isinstance(pair[1], str) for pair in acknowledgements)
                and len(dict(acknowledgements)) == 290
                and dict(acknowledgements) == own, "Sender ACK IDs differ from persisted messages")
    return digest, page_hashes


def audit_runtime(report):
    profile, result = report["profile"], report["result"]
    require(all(profile[key] == expected for key, expected in {
        "vus": 20, "users": 21, "slowPeers": 1, "holdSeconds": 620,
        "rampUp": "10s", "hold": "605s", "rampDown": "10s",
    }.items()) and profile["legacyToken"] is False, "Unexpected workload profile")
    require(all(result[key] == expected for key, expected in {
        "exitCode": 0, "handshakes": 20, "completed": 20, "heartbeatAcks": 400,
    }.items()), "Healthy session or heartbeat contract failed")
    expected_checks = {name: 20 for name in [
        "login succeeded", "ws-ticket issued", "ws handshake succeeded (status 101)",
        "ws session completed hold", "ws session had no errors",
        "fanout received all expected unique deliveries", "fanout HTTP and own WebSocket IDs agree",
    ]}
    expected_checks["fanout message accepted with correct actor/channel"] = 5800
    checks = result["checks"]
    require(set(checks) == set(expected_checks) and all(
        type(checks[name]["passes"]) is int and checks[name]["passes"] == passes
        and type(checks[name]["fails"]) is int and checks[name]["fails"] == 0
        for name, passes in expected_checks.items()), "Incomplete or failed workload checks")
    samples = report["samples"]
    baseline = [row for row in samples if row["phase"] == "baseline"]
    recovery = [row for row in samples if row["phase"] == "recovery"]
    load = [row for row in samples if row["phase"] == "load"]
    require(len(baseline) == 3 and len(recovery) == 6 and bool(load), "Missing resource samples")
    require(any(row["pumps"] == {"read": 21, "write": 21} for row in load), "No twenty-one-peer observation")
    require(any(row["pumps"] == {"read": 20, "write": 20} for row in load), "No healthy-only observation")
    require(all(row["pumps"] == {"read": 0, "write": 0} for row in recovery), "Pumps survived recovery")
    for row in samples:
        database = row["database"]
        require(type(database["connections"]) is int and database["connections"] > 0
                and database["connections"] == database["tlsConnections"] == database["clientCertificates"],
                "Application mTLS sample failed or has no connections")
    slow = report["slow"]
    require(slow["exitCode"] == 0 and slow["stderrPresent"] is False
            and slow["readableAfterRetirement"] is True and len(slow["events"]) == 2
            and not slow.get("reportWriteFailed", False),
            "Slow peer did not complete the isolation observation")
    connected, finished = slow["events"]
    require(connected["event"] == "connected" and finished["event"] == "finished"
            and finished["reason"] == "write_failed" and finished["keepalive_pairs"] >= 2
            and 15000 <= finished["elapsed_ms"] < 750000,
            "Slow peer liveness or retirement contract failed")
    require(connected["post_upgrade_reader"] is False and finished["post_upgrade_reader"] is False
            and connected["receive_buffer_requested_bytes"] == 1024, "Slow peer read output or changed buffer request")
    isolation = slow["isolation"]
    require(any(row["phase"] == "slow_admission" and row["pumps"] == {"read": 1, "write": 1}
                for row in samples), "No admitted slow peer observation")
    require(any(row["at"] == isolation["peakAt"] and row["pumps"] == {"read": 21, "write": 21} for row in load)
            and any(row["at"] == isolation["retiredAt"] and row["pumps"] == {"read": 20, "write": 20} for row in load),
            "Isolation transition differs from recorded samples")
    def instant(value):
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        require(parsed.tzinfo is not None, "Observation timestamp has no timezone")
        return parsed
    count = sum(row["pumps"] == {"read": 20, "write": 20}
                and instant(row["at"]) >= instant(finished["at"]) for row in load)
    require(instant(isolation["peakAt"]) < instant(isolation["retiredAt"])
            and 10 <= isolation["healthySamplesAfterProbeExit"] <= count, "Missing isolation transition")


def audit_profile(fixture):
    fixture = Path(fixture)
    report, owner = read_json(fixture / "capacity-report.json"), read_json(fixture / "owner.json")
    require(report["resultStatus"] == "completed" and report["failurePhases"] == []
            and report["databaseDropped"] is True and report["sourceStable"] is True
            and report["logWriteFailed"] is False, "Profile or cleanup did not complete")
    commit = report["sourceCommit"]
    require(isinstance(commit, str) and re.fullmatch(r"[a-f0-9]{40}", commit)
            and owner["sourceCommit"] == commit == report["loadCommit"], "Source revision differs")
    require(read_json(fixture / "launcher-cleanup.json")["failures"] == [], "Launcher cleanup failed")
    require(not any((fixture / name).exists() for name in ["capacity-private.json", "client.key", "client.crt", "ca.crt"])
            and not list(fixture.glob("run-*/hichat-e2e-postgres.json")), "Private fixture credentials remain")
    source_files = audit_sources(fixture, report["sourceSnapshot"])
    audit_runtime(report)
    digest, page_hashes = audit_history(fixture, report["fanout"])
    return {
        "result": "PASS", "sourceCommit": commit, "sourceFilesMatched": source_files,
        "messages": 5800, "healthyDeliveries": 116000, "historyPages": 58,
        "receiverDigestsMatched": 20, "senderAcknowledgementsMatched": 5800, "digest": digest,
        "reportSha256": sha256(fixture / "capacity-report.json"),
        "historyPageHashes": page_hashes,
        "scope": "Independent history, source, recorded session/resource and cleanup-report audit. "
                 "Host process/container/image absence requires separate observation. "
                 "Not capacity, variance, churn, soak, native/physical or full RF acceptance.",
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("fixture", type=Path)
    args = parser.parse_args()
    failure = None
    try:
        result = audit_profile(args.fixture)
    except AuditError as error:
        failure = str(error)
    except Exception:
        # Refuse incomplete evidence without echoing its potentially private contents.
        failure = "invalid or incomplete evidence"
    if failure:
        print(f"Local profile audit failed: {failure}", file=sys.stderr)
        result = {"result": "FAIL", "reason": failure}
    result["auditedAt"] = datetime.now().astimezone().isoformat()
    try:
        # A rejected rerun must not leave a previous PASS as the latest verdict.
        (args.fixture / "independent-audit.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    except OSError:
        print("Local profile audit report could not be written", file=sys.stderr)
        return 1
    if failure:
        return 1
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
