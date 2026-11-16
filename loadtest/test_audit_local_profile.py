import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from audit_local_profile import AuditError, audit_profile


class LocalProfileAuditTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="hichat-audit-contract-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.commit = "a" * 40
        self.write("owner.json", {"sourceCommit": self.commit})
        self.write("launcher-cleanup.json", {"failures": []})
        source_files = {}
        for name in ["server/go.mod", "e2e/scripts/pg-fixture.go", "loadtest/ws_connect.js"]:
            path = self.root / "source" / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"contract-only input\n")
            source_files[name] = hashlib.sha256(path.read_bytes()).hexdigest()
        snapshot = {"files": source_files, "sha256": self.digest(source_files)}
        # Reverse lexical order guards the published sender-rank contract.
        users = [f"user-{i:02}" for i in reversed(range(20))]
        rows, canonical, receipts = [], [], []
        for rank, user in enumerate(users):
            acknowledged = []
            for sequence in range(1, 291):
                identity = f"message-{rank}-{sequence}"
                acknowledged.append([sequence, identity])
                canonical.append([user, sequence, identity])
                rows.append({"id": identity, "user_id": user, "channel_id": "channel",
                             "source_sequence": len(rows) + 1,
                             "created_at": "2026-01-02T00:00:00Z" if sequence % 2 else "2026-01-01T00:00:00Z",
                             "content": json.dumps({"probe": "probe", "sender": user, "sequence": sequence})})
            receipts.append({"receiver": user, "summary": {"complete": True}, "acknowledged": acknowledged})
        digest = self.digest(canonical)
        for receipt in receipts:
            receipt["digest"] = digest
        before = ""
        for index in range(1, 59):
            page_rows = rows[5800 - index * 100:5900 - index * 100]
            self.write(f"history-pages/{index}.json", {"before": before, "limit": 100,
                       "has_more": index < 58, "has_more_after": False, "messages": page_rows})
            before = page_rows[0]["id"]
        database = {"connections": 3, "tlsConnections": 3, "clientCertificates": 3}

        def sample(phase, second, pumps):
            return {"phase": phase, "at": self.at(second), "pumps": {"read": pumps, "write": pumps}, "database": database.copy()}

        samples = [sample("baseline", i, 0) for i in range(3)]
        samples += [sample("slow_admission", 3, 1), sample("load", 10, 21), sample("load", 50, 20)]
        samples += [sample("load", i, 20) for i in range(63, 75)]
        samples += [sample("recovery", i, 0) for i in range(650, 656)]
        checks = {name: {"passes": 20, "fails": 0} for name in [
            "login succeeded", "ws-ticket issued", "ws handshake succeeded (status 101)",
            "ws session completed hold", "ws session had no errors",
            "fanout received all expected unique deliveries", "fanout HTTP and own WebSocket IDs agree",
        ]}
        checks["fanout message accepted with correct actor/channel"] = {"passes": 5800, "fails": 0}
        self.report = {"sourceCommit": self.commit, "loadCommit": self.commit, "sourceSnapshot": snapshot,
                       "resultStatus": "completed", "failurePhases": [], "databaseDropped": True,
                       "sourceStable": True, "logWriteFailed": False,
                       "profile": {"vus": 20, "users": 21, "slowPeers": 1, "holdSeconds": 620,
                                   "rampUp": "10s", "hold": "605s", "rampDown": "10s", "legacyToken": False},
                       "result": {"exitCode": 0, "handshakes": 20, "completed": 20, "heartbeatAcks": 400, "checks": checks},
                       "samples": samples,
                       "slow": {"exitCode": 0, "stderrPresent": False, "readableAfterRetirement": True,
                                "events": [{"event": "connected", "at": self.at(3), "post_upgrade_reader": False,
                                            "receive_buffer_requested_bytes": 1024},
                                           {"event": "finished", "at": self.at(63), "reason": "write_failed",
                                            "keepalive_pairs": 4, "elapsed_ms": 60000, "post_upgrade_reader": False}],
                                "isolation": {"peakAt": self.at(10), "retiredAt": self.at(50), "healthySamplesAfterProbeExit": 12}},
                       "fanout": {"userIds": users, "messagesPerSender": 290, "channel": "channel", "probeId": "probe",
                                  "result": {"sent": 5800, "received": 116000, "receivers": 20, "duplicates": 0,
                                             "invalid": 0, "persisted": 5800, "historyPages": 58, "digest": digest, "receipts": receipts}}}
        self.save()

    @staticmethod
    def digest(value):
        return hashlib.sha256(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()

    @staticmethod
    def at(second):
        return (datetime(2026, 1, 1, tzinfo=timezone.utc) + timedelta(seconds=second)).isoformat().replace("+00:00", "Z")

    def write(self, name, value):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value), encoding="utf-8")

    def save(self):
        self.write("capacity-report.json", self.report)

    def test_complete_reversed_sender_order_and_timestamp_inversions_pass(self):
        result = audit_profile(self.root)
        self.assertEqual(result["result"], "PASS")
        self.assertEqual(result["messages"], 5800)
        self.assertEqual(result["sourceFilesMatched"], 3)
        self.assertEqual(len(result["historyPageHashes"]), 58)

    def test_counter_claim_cannot_replace_real_history(self):
        (self.root / "history-pages/58.json").unlink()
        with self.assertRaisesRegex(AuditError, "fifty-eight"):
            audit_profile(self.root)

    def test_wrong_page_order_is_rejected(self):
        path = self.root / "history-pages/1.json"
        page = json.loads(path.read_text())
        page["messages"][0], page["messages"][1] = page["messages"][1], page["messages"][0]
        self.write("history-pages/1.json", page)
        with self.assertRaisesRegex(AuditError, "page order"):
            audit_profile(self.root)

    def test_wrong_ack_is_rejected_even_when_all_counters_pass(self):
        self.report["fanout"]["result"]["receipts"][0]["acknowledged"][0][1] = "wrong-id"
        self.save()
        with self.assertRaisesRegex(AuditError, "ACK IDs"):
            audit_profile(self.root)

    def test_changed_source_is_rejected_despite_source_stable_flag(self):
        (self.root / "source/server/go.mod").write_text("changed", encoding="utf-8")
        with self.assertRaisesRegex(AuditError, "source hashes"):
            audit_profile(self.root)

    def test_missing_recorded_isolation_cannot_be_claimed_by_summary(self):
        self.report["samples"] = [row for row in self.report["samples"] if row["at"] != self.at(10)]
        self.save()
        with self.assertRaisesRegex(AuditError, "twenty-one"):
            audit_profile(self.root)

    def test_no_application_connections_cannot_pass_equal_zero_tls_counts(self):
        self.report["samples"][0]["database"] = {"connections": 0, "tlsConnections": 0, "clientCertificates": 0}
        self.save()
        with self.assertRaisesRegex(AuditError, "mTLS"):
            audit_profile(self.root)

    def test_cleanup_failure_or_remaining_credentials_rejects_profile(self):
        self.write("launcher-cleanup.json", {"failures": ["container"]})
        with self.assertRaisesRegex(AuditError, "cleanup"):
            audit_profile(self.root)
        self.write("launcher-cleanup.json", {"failures": []})
        (self.root / "client.key").write_text("contract placeholder", encoding="utf-8")
        with self.assertRaisesRegex(AuditError, "credentials remain"):
            audit_profile(self.root)

    def test_optimized_python_cannot_disable_acceptance_checks(self):
        self.report["resultStatus"] = "failed"
        self.save()
        process = subprocess.run([sys.executable, "-O", str(Path(__file__).with_name("audit_local_profile.py")), str(self.root)],
                                 capture_output=True, text=True, timeout=15)
        self.assertEqual(process.returncode, 1)
        self.assertIn("did not complete", process.stderr)
        self.assertEqual(json.loads((self.root / "independent-audit.json").read_text())["result"], "FAIL")

    def test_failed_rerun_replaces_previous_pass_verdict(self):
        command = [sys.executable, str(Path(__file__).with_name("audit_local_profile.py")), str(self.root)]
        passed = subprocess.run(command, capture_output=True, timeout=15)
        self.assertEqual(passed.returncode, 0)
        self.assertEqual(json.loads((self.root / "independent-audit.json").read_text())["result"], "PASS")
        self.report["fanout"]["result"]["receipts"][0]["digest"] = "wrong-digest"
        self.save()
        rejected = subprocess.run(command, capture_output=True, timeout=15)
        self.assertEqual(rejected.returncode, 1)
        self.assertEqual(json.loads((self.root / "independent-audit.json").read_text())["result"], "FAIL")

    def test_audit_report_write_failure_cannot_return_success(self):
        (self.root / "independent-audit.json").mkdir()
        process = subprocess.run([sys.executable, str(Path(__file__).with_name("audit_local_profile.py")), str(self.root)],
                                 capture_output=True, text=True, timeout=15)
        self.assertEqual(process.returncode, 1)
        self.assertIn("report could not be written", process.stderr)
        self.assertEqual(process.stdout, "")


if __name__ == "__main__":
    unittest.main()
