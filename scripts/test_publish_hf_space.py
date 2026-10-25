import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location("space_release", Path(__file__).with_name("publish-hf-space.py"))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class PublishSafetyTests(unittest.TestCase):
    def test_only_the_frontend_contract_is_managed_from_electron(self):
        self.assertTrue(release.managed("electron/voice-overlay-contract.ts"))
        self.assertFalse(release.managed("electron/main.ts"))
        self.assertFalse(release.managed("data/uploads/user.png"))

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        previous = Path.cwd()
        os.chdir(self.temp.name)
        self.addCleanup(os.chdir, previous)
        Path("server").mkdir()
        Path("server/main.go").write_text("package main\n")
        self.api = Mock()
        self.api.space_info.return_value.sha = "reviewed-parent"
        self.api.list_repo_tree.return_value = [SimpleNamespace(path="server/old.go", blob_id="old", lfs=None), SimpleNamespace(path="data/uploads/user.png", blob_id="user", lfs=None)]
        self.api.create_commit.return_value = SimpleNamespace(oid="new", commit_url="https://example.test/new")
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.object(release, "HfApi", return_value=self.api))
        self.stack.enter_context(patch.object(release.subprocess, "check_output", side_effect=lambda args, **kwargs: "source-commit\n" if args[1] == "rev-parse" else b"server/main.go\0"))
        self.stack.enter_context(patch.dict(os.environ, {"HF_TOKEN": "disposable-test-value"}))

    def test_verification_receives_exact_publish_result_commit(self):
        output = Path("github-output")
        with patch.dict(os.environ, {"GITHUB_OUTPUT": str(output)}):
            release.record_deployed_commit("a" * 40)
        self.assertEqual(output.read_text(encoding="utf-8"), "deployed_commit=" + "a" * 40 + "\n")

    def run_command(self, *args):
        output = io.StringIO()
        with patch("sys.argv", ["publish-hf-space.py", "--expected-head", "reviewed-parent", *args]), contextlib.redirect_stdout(output):
            release.main()
        return output.getvalue()

    def test_preview_never_mutates_and_only_plans_managed_deletion(self):
        result = self.run_command()
        self.api.create_commit.assert_not_called()
        self.assertIn('"server/old.go"', result)
        self.assertNotIn("data/uploads/user.png", result)
        self.assertNotIn("disposable-test-value", result)

    def test_changed_parent_aborts_before_reading_sources_or_mutating(self):
        self.api.space_info.return_value.sha = "concurrent-parent"
        with self.assertRaisesRegex(SystemExit, "HEAD changed"):
            self.run_command("--publish")
        self.api.create_commit.assert_not_called()
        self.api.list_repo_tree.assert_not_called()

    def test_publish_requires_exact_reviewed_plan(self):
        with self.assertRaisesRegex(SystemExit, "previously reviewed"):
            self.run_command("--publish", "--reviewed-plan-sha256", "wrong")
        self.api.create_commit.assert_not_called()
        plan = {"source_commit": "source-commit", "space_parent": "reviewed-parent", "add_or_update": ["server/main.go"], "remove_managed_source": ["server/old.go"], "hub_may_update_lfs_metadata": True}
        digest = hashlib.sha256(json.dumps(plan, sort_keys=True).encode()).hexdigest()
        self.run_command("--publish", "--reviewed-plan-sha256", digest)
        call = self.api.create_commit.call_args
        self.assertEqual(call.kwargs["parent_commit"], "reviewed-parent")
        self.assertEqual([operation.path_in_repo for operation in call.kwargs["operations"]], ["server/main.go", "server/old.go"])

    def test_missing_materialized_lfs_object_aborts(self):
        Path("server/main.go").write_bytes(b"version https://git-lfs.github.com/spec/v1\n")
        with self.assertRaisesRegex(SystemExit, "Unmaterialized LFS"):
            self.run_command("--publish")
        self.api.create_commit.assert_not_called()


if __name__ == "__main__":
    unittest.main()
