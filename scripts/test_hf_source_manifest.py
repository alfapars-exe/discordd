import subprocess
import tempfile
from pathlib import Path
import unittest

from hf_source_manifest import MANIFEST, managed, validate_rollback


class RollbackTests(unittest.TestCase):
    def test_boundaries(self):
        for path in MANIFEST["files"] + ["client/src/App.tsx", "server/main.go"]:
            self.assertTrue(managed(path))
            self.assertTrue(managed(path, rollback=True))
        for path in ["data/uploads/x", "electron/main.ts", "client/../.env", "server/.env", "client/.env.production", "", "/server/x"]:
            self.assertFalse(managed(path, rollback=True), path)
        self.assertFalse(managed(".gitattributes"))
        self.assertTrue(managed(".gitattributes", rollback=True))

    def test_real_git_restore(self):
        with tempfile.TemporaryDirectory() as directory:
            def git(*args):
                return subprocess.check_output(["git", "-C", directory, *args], stderr=subprocess.DEVNULL).decode().strip()
            git("init")
            git("config", "user.name", "test")
            git("config", "user.email", "test@example.invalid")
            root = Path(directory)
            (root / "README.md").write_text("before")
            git("add", ".")
            git("commit", "-m", "initial")
            before = git("rev-parse", "HEAD")
            (root / "electron").mkdir()
            for path in MANIFEST["files"]:
                if path.startswith("electron/"):
                    (root / path).write_text("export {}")
            git("add", ".")
            git("commit", "-m", "contracts")
            after = git("rev-parse", "HEAD")
            self.assertEqual(len(validate_rollback(directory, after, before)), 3)
            with self.assertRaises(ValueError):
                validate_rollback(directory, before, before)
            git("revert", "--no-edit", after)
            git("diff", "--exit-code", before, "HEAD")
            parent = git("rev-parse", "HEAD")
            (root / "secrets.txt").write_text("not application source")
            git("add", ".")
            git("commit", "-m", "unrelated")
            with self.assertRaises(ValueError):
                validate_rollback(directory, git("rev-parse", "HEAD"), parent)


if __name__ == "__main__":
    unittest.main()
