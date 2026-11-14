import importlib.util
import io
import json
from pathlib import Path
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location("postgres_runner", Path(__file__).with_name("run-postgres-tests.py"))
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class PostgreSQLRunnerTests(unittest.TestCase):
    service_passes = (
        "--- PASS: TestDeliveryClaimCancellationLogging (0.01s)\n"
        "--- PASS: TestDeliveryStopCancelsPoolWait (0.01s)\n"
        "--- PASS: TestVoiceUsagePostgresShutdownJoinsAcceptedCredit (0.01s)\n"
        "--- PASS: TestVoiceUsagePostgresShutdownFinalizesActiveSession (0.01s)\n"
        "--- PASS: TestVoiceUsagePostgresShutdownCreditsBeforeMediaWait (0.01s)\n"
        "--- PASS: TestVoiceUsagePostgresShutdownHandsOffAllBeforeMedia (0.01s)\n"
        "--- PASS: TestVoiceUsagePostgresChannelDeletionHandsOffAllBeforeMedia (0.01s)\n"
        "--- PASS: TestVoiceUsagePostgresShutdownRecoversFailedApplication (0.01s)\n"
        "--- PASS: TestVoiceUsagePostgresShutdownJoinsPermissionRecheck (0.01s)\n"
        "--- PASS: TestVoiceUsagePostgresLateMemberRevocationPreservesCredit (0.01s)\n"
        "--- PASS: TestVoiceUsagePostgresServiceHandoffSurvivesApplyFailure (0.01s)\n"
        "--- PASS: TestVoiceUsagePostgresPendingRecovery (0.01s)\n"
        "--- PASS: TestVoiceUsagePostgresReplayTransaction (0.01s)\n"
        "--- PASS: TestVoiceUsageCreditPostgresDeadline (10.01s)\n"
        "--- PASS: TestVoiceUsageCreditPostgresAdditiveWrites (0.01s)\n"
        "--- PASS: TestVoiceMaintenanceAFKPostgresCancellation (0.01s)\n"
        "--- PASS: TestChannelDeliveryConcurrentRetryAndDeletion (0.01s)\n"
        "--- PASS: TestDMIdempotentAttachmentsConcurrentReplayKeepsOneOrderedSet (0.01s)\n"
        "--- PASS: TestDMOutboxCommitRecoveryReplayAndAuthorization (0.01s)\n"
        "--- PASS: TestDMMarkUnreadFrom_ConcurrentSend (0.01s)\n"
        "--- PASS: TestPostgresRolePatchConcurrentChanges (0.01s)\n"
        "--- PASS: TestPostgresMemberRoleReplacement (0.01s)\n"
        "--- PASS: TestPostgresMetricsCollectorCancellation (0.01s)\n"
    )

    def execute(self, events, code=0, service_output=service_passes):
        process = Mock(stdout=io.StringIO("\n".join(json.dumps(event) for event in events)))
        process.wait.return_value = code
        self.output = io.StringIO()
        with patch.dict(runner.os.environ, {"HICHAT_TEST_POSTGRES_DSN": "postgres://postgres@127.0.0.1/test"}), patch.object(runner.subprocess, "Popen", return_value=process), patch.object(runner.subprocess, "run", return_value=Mock(stdout=service_output, returncode=0)), patch("sys.stdout", self.output), patch("sys.stderr", io.StringIO()):
            return runner.main()

    def test_required_service_contracts_must_run_on_postgres(self):
        for name in ("TestPostgresRolePatchConcurrentChanges", "TestPostgresMemberRoleReplacement",
                     "TestPostgresMetricsCollectorCancellation"):
            with self.subTest(name=name):
                remaining = "\n".join(line for line in self.service_passes.splitlines() if name not in line)
                self.assertEqual(self.execute(self.completed(), service_output=remaining), 1)

    def test_delivery_contracts_must_run_even_when_role_tests_pass(self):
        for name in (
            "TestChannelDeliveryConcurrentRetryAndDeletion",
            "TestDMIdempotentAttachmentsConcurrentReplayKeepsOneOrderedSet",
            "TestDMOutboxCommitRecoveryReplayAndAuthorization",
            "TestDMMarkUnreadFrom_ConcurrentSend",
        ):
            with self.subTest(name=name):
                remaining = "\n".join(line for line in self.service_passes.splitlines() if name not in line)
                self.assertEqual(self.execute(self.completed(), service_output=remaining), 1)

    def test_driver_urls_are_redacted_in_both_test_phases(self):
        url = "PostgreSQL://fixture:secret@localhost/alternate"
        events = self.completed() + [{"Action": "output", "Output": f"driver: {url}\n"}]
        self.assertEqual(self.execute(events, service_output=self.service_passes + url), 0)
        self.assertNotIn("fixture:secret", self.output.getvalue())
        self.assertEqual(self.output.getvalue().count(runner.REDACTED_DATABASE), 2)

    def test_reported_failure_cannot_pass_with_successful_process_exit(self):
        events = self.completed() + [{
            "Action": "fail",
            "Package": "github.com/argeinfina/hichat/repository",
            "Test": "TestPostgresLock",
        }]
        self.assertEqual(self.execute(events), 1)

    def test_non_object_json_is_reported_as_invalid_output(self):
        for value in (None, [], "unexpected", 42):
            with self.subTest(value=value):
                self.assertEqual(self.execute(self.completed() + [value]), 1)

    def test_delivery_stop_contract_must_emit_pass(self):
        output = "\n".join(line for line in self.service_passes.splitlines() if "TestDeliveryStopCancelsPoolWait" not in line)
        self.assertEqual(self.execute(self.completed(), service_output=output), 1)

    def test_afk_stop_must_pass_real_postgres(self):
        output = "\n".join(line for line in self.service_passes.splitlines() if "TestVoiceMaintenanceAFKPostgresCancellation" not in line)
        self.assertEqual(self.execute(self.completed(), service_output=output), 1)

    def test_usage_contracts_must_run(self):
        for name in ("TestVoiceUsagePostgresShutdownJoinsAcceptedCredit", "TestVoiceUsagePostgresShutdownFinalizesActiveSession", "TestVoiceUsagePostgresShutdownCreditsBeforeMediaWait", "TestVoiceUsagePostgresShutdownHandsOffAllBeforeMedia", "TestVoiceUsagePostgresChannelDeletionHandsOffAllBeforeMedia", "TestVoiceUsagePostgresShutdownRecoversFailedApplication", "TestVoiceUsagePostgresShutdownJoinsPermissionRecheck", "TestVoiceUsagePostgresLateMemberRevocationPreservesCredit", "TestVoiceUsagePostgresServiceHandoffSurvivesApplyFailure", "TestVoiceUsagePostgresPendingRecovery", "TestVoiceUsagePostgresReplayTransaction", "TestVoiceUsageCreditPostgresDeadline", "TestVoiceUsageCreditPostgresAdditiveWrites"):
            output = "\n".join(line for line in self.service_passes.splitlines() if name not in line)
            self.assertEqual(self.execute(self.completed(), service_output=output), 1)

    def test_usage_migration_pass_is_mandatory(self):
        events = [event for event in self.completed() if event.get("Test") != "TestPostgresVoiceUsageMigrationPreservesTotals"]
        self.assertEqual(self.execute(events), 1)

    def completed(self):
        return [
            {"Action": "pass", "Package": "github.com/argeinfina/hichat", "Test": "TestPurgeExpiredNotificationsPostgres"},
            {"Action": "pass", "Package": "github.com/argeinfina/hichat", "Test": "TestActiveVoiceProcessPostgresSignal"},
            {"Action": "pass", "Package": "github.com/argeinfina/hichat"},
            {"Action": "pass", "Package": "github.com/argeinfina/hichat/repository"},
            {"Action": "pass", "Package": "github.com/argeinfina/hichat/database", "Test": "TestPostgresVoiceUsageMigrationPreservesTotals"},
            {"Action": "pass", "Package": "github.com/argeinfina/hichat/database"},
        ]

    def test_required_skip_cannot_be_a_green_run(self):
        self.assertEqual(self.execute(self.completed()), 0)
        self.assertEqual(self.execute(self.completed() + [{"Action": "skip", "Test": "TestPostgresLock"}]), 1)

    def test_postgres_retention_skip_fails_but_unrelated_server_skip_is_allowed(self):
        self.assertEqual(
            self.execute(self.completed() + [{
                "Action": "skip",
                "Package": "github.com/argeinfina/hichat",
                "Test": "TestPurgeExpiredNotificationsPostgres",
            }]),
            1,
        )
        self.assertEqual(
            self.execute(self.completed() + [{
                "Action": "skip",
                "Package": "github.com/argeinfina/hichat",
                "Test": "TestMusicWorkerBridgePrivateExecutorLifecycle",
            }]),
            0,
        )

    def test_postgres_retention_must_emit_an_explicit_pass(self):
        target_pass = self.completed()[0]
        without_target = self.completed()[1:]
        self.assertEqual(self.execute(without_target), 1)  # package pass, target missing
        self.assertEqual(self.execute(self.completed()[:-1]), 1)  # database package missing
        self.assertEqual(self.execute(without_target + [{
            "Action": "fail",
            "Package": "github.com/argeinfina/hichat",
            "Test": "TestPurgeExpiredNotificationsPostgres",
        }]), 1)
        self.assertEqual(self.execute(without_target + [{
            "Action": "skip",
            "Package": "github.com/argeinfina/hichat",
            "Test": "TestPurgeExpiredNotificationsPostgres",
        }]), 1)
        self.assertEqual(self.execute([event for event in self.completed() if event != target_pass]), 1)

    def test_missing_package_or_process_failure_is_retained(self):
        self.assertEqual(self.execute(self.completed()[:2]), 1)
        self.assertEqual(self.execute(self.completed(), code=2), 2)

    def test_remote_or_absent_dsn_is_rejected_before_launch(self):
        for dsn in ["", "postgres://postgres@database.example.test/test"]:
            with patch.dict(runner.os.environ, {"HICHAT_TEST_POSTGRES_DSN": dsn}), patch.object(runner.subprocess, "Popen") as launch:
                with self.assertRaisesRegex(SystemExit, "loopback"):
                    runner.main()
                launch.assert_not_called()

    def test_active_process_contract_cannot_be_missing_skipped_or_wrong_package(self):
        name = "TestActiveVoiceProcessPostgresSignal"
        without = [event for event in self.completed() if event.get("Test") != name]
        self.assertEqual(self.execute(without), 1)
        self.assertEqual(self.execute(without + [{"Action": "skip", "Package": "github.com/argeinfina/hichat", "Test": name}]), 1)
        self.assertEqual(self.execute(without + [{"Action": "pass", "Package": "github.com/argeinfina/hichat/database", "Test": name}]), 1)
