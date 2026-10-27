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
    def execute(self, events, code=0):
        process = Mock(stdout=io.StringIO("\n".join(json.dumps(event) for event in events)))
        process.wait.return_value = code
        with patch.dict(runner.os.environ, {"HICHAT_TEST_POSTGRES_DSN": "postgres://postgres@127.0.0.1/test"}), patch.object(runner.subprocess, "Popen", return_value=process), patch("sys.stdout", io.StringIO()), patch("sys.stderr", io.StringIO()):
            return runner.main()

    def completed(self):
        return [
            {"Action": "pass", "Package": "github.com/argeinfina/hichat"},
            {"Action": "pass", "Package": "github.com/argeinfina/hichat/repository"},
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

    def test_missing_package_or_process_failure_is_retained(self):
        self.assertEqual(self.execute(self.completed()[:2]), 1)
        self.assertEqual(self.execute(self.completed(), code=2), 2)

    def test_remote_or_absent_dsn_is_rejected_before_launch(self):
        for dsn in ["", "postgres://postgres@database.example.test/test"]:
            with patch.dict(runner.os.environ, {"HICHAT_TEST_POSTGRES_DSN": dsn}), patch.object(runner.subprocess, "Popen") as launch:
                with self.assertRaisesRegex(SystemExit, "loopback"):
                    runner.main()
                launch.assert_not_called()
