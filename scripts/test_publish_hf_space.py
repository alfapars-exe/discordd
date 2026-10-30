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
    def test_only_pure_frontend_contracts_are_managed_from_electron(self):
        for path in release.FRONTEND_CONTRACTS:
            self.assertTrue(release.managed(path))
        self.assertFalse(release.managed("electron/main.ts"))
        self.assertFalse(release.managed("electron/cs2-join-controller.ts"))
        self.assertFalse(release.managed("data/uploads/user.png"))

    def test_contracts_are_available_in_the_clean_docker_frontend_stage(self):
        root = Path(__file__).resolve().parents[1]
        dockerfile = (root / "Dockerfile").read_text(encoding="utf-8")
        exclusions = (root / ".dockerignore").read_text(encoding="utf-8").splitlines()
        for path in release.FRONTEND_CONTRACTS:
            self.assertTrue((root / path).is_file())
            self.assertIn(f"COPY {path} /app/{path}", dockerfile)
            self.assertIn(f"!{path}", exclusions)

    def test_frontend_sources_are_valid_utf8_for_rolldown(self):
        root = Path(__file__).resolve().parents[1]
        sources = (root / "client/src").rglob("*")
        for path in sources:
            if path.suffix in {".ts", ".tsx", ".json", ".css"}:
                with self.subTest(path=str(path.relative_to(root))):
                    path.read_bytes().decode("utf-8", errors="strict")

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
        self.api.pause_space.return_value.stage = "PAUSED"
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
        self.api.pause_space.assert_not_called()
        self.api.restart_space.assert_not_called()
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
        digest = self.preview_hash()
        self.run_command("--publish", "--reviewed-plan-sha256", digest)
        call = self.api.create_commit.call_args
        self.assertEqual(call.kwargs["parent_commit"], "reviewed-parent")
        self.assertEqual([operation.path_in_repo for operation in call.kwargs["operations"]], ["server/main.go", "server/old.go"])

    def test_publish_stops_old_process_before_commit_and_restarts_afterward(self):
        digest = self.preview_hash()
        self.run_command("--publish", "--reviewed-plan-sha256", digest)
        actions = [call[0] for call in self.api.mock_calls]
        self.assertLess(actions.index("pause_space"), actions.index("create_commit"))
        self.assertLess(actions.index("create_commit"), actions.index("restart_space"))

    def test_unconfirmed_stop_refuses_publication(self):
        digest = self.preview_hash()
        self.api.pause_space.return_value.stage = "RUNNING"
        self.api.get_space_runtime.return_value.stage = "RUNNING"
        with patch.object(release.time, "sleep"), self.assertRaisesRegex(SystemExit, "did not stop"):
            self.run_command("--publish", "--reviewed-plan-sha256", digest)
        self.api.create_commit.assert_not_called()
        self.api.restart_space.assert_not_called()

    def preview_hash(self):
        return json.loads(self.run_command().splitlines()[-1])["plan_sha256"]

    def test_same_path_with_changed_bytes_invalidates_review(self):
        digest = self.preview_hash()
        Path("server/main.go").write_text("package replacement\n")
        with self.assertRaisesRegex(SystemExit, "previously reviewed"):
            self.run_command("--publish", "--reviewed-plan-sha256", digest)
        self.api.create_commit.assert_not_called()

    def test_upload_is_bound_to_reviewed_bytes_even_if_file_changes_after_validation(self):
        digest = self.preview_hash()
        reviewed_bytes = Path("server/main.go").read_bytes()

        def publish(*args, **kwargs):
            Path("server/main.go").write_text("package changed_after_review\n")
            addition = kwargs["operations"][0]
            self.assertEqual(addition.path_or_fileobj, reviewed_bytes)
            return SimpleNamespace(oid="new", commit_url="https://example.test/new")

        self.api.create_commit.side_effect = publish
        self.run_command("--publish", "--reviewed-plan-sha256", digest)

    def test_manifest_covers_size_and_sha256_of_unchanged_sources_too(self):
        data = Path("server/main.go").read_bytes()
        blob = hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()
        self.api.list_repo_tree.return_value = [SimpleNamespace(path="server/main.go", blob_id=blob, lfs=None)]
        preview = self.run_command()
        plan = json.JSONDecoder().raw_decode(preview)[0]
        self.assertEqual(plan["source_files"], [{"path": "server/main.go", "size": len(data), "sha256": hashlib.sha256(data).hexdigest()}])
        self.assertEqual(plan["add_or_update"], [])
        self.run_command("--publish", "--reviewed-plan-sha256", json.loads(preview.splitlines()[-1])["plan_sha256"])
        self.api.create_commit.assert_not_called()

    def test_crlf_lfs_pointer_is_not_uploaded(self):
        Path("server/main.go").write_bytes(b"version https://git-lfs.github.com/spec/v1\r\n")
        with self.assertRaisesRegex(SystemExit, "Unmaterialized LFS"):
            self.run_command("--publish")
        self.api.create_commit.assert_not_called()

    def test_missing_materialized_lfs_object_aborts(self):
        Path("server/main.go").write_bytes(b"version https://git-lfs.github.com/spec/v1\n")
        with self.assertRaisesRegex(SystemExit, "Unmaterialized LFS"):
            self.run_command("--publish")
        self.api.create_commit.assert_not_called()


if __name__ == "__main__":
    unittest.main()
