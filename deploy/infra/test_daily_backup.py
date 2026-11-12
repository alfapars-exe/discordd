import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).with_name("backup.sh")


@unittest.skipUnless(os.name == "posix", "backup.sh runs on the Linux backup host")
class DailyBackupTests(unittest.TestCase):
    def test_interrupted_copy_then_retry(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "secrets").mkdir()
            (root / "secrets/backup-recipient").write_text("test recipient")
            # Redirect the host paths before running the real backup script.
            script = SCRIPT.read_text().replace("/opt/hichat-infra", directory)
            script = script.replace("/srv/hichat", directory).replace("/run/lock", directory)
            runner = root / "backup.sh"
            runner.write_text(script)
            commands = root / "commands"
            commands.write_text("""
docker() { echo archive-content; }
age() { cat > "${!#}"; }
cp() {
  if [[ "$FAIL_COPY" == 1 ]]; then
    echo truncated > "${!#}"
    return 1
  fi
  command cp "$@"
}
""")
            upload = root / "backup-upload"
            upload.write_text('#!/bin/sh\ncmp "$1" "$2" && touch uploaded\n')
            upload.chmod(0o700)
            env = dict(os.environ, BASH_ENV=str(commands), FAIL_COPY="1")
            failed = subprocess.run(["bash", runner], env=env, capture_output=True)
            self.assertNotEqual(failed.returncode, 0)
            backups = root / "backups"
            self.assertEqual(list((backups / "daily").iterdir()), [])
            self.assertFalse((root / "uploaded").exists())
            self.assertFalse((backups / "last-success").exists())

            # Retention must count only scheduled archives, including on retry.
            manual = backups / "daily" / "000-manual.dump.age"
            manual.write_bytes(b"manual backup")
            for day in range(1, 8):
                (backups / "daily" / f"200001{day:02d}.dump.age").touch()
            subprocess.run(["bash", runner], env={**env, "FAIL_COPY": "0"}, check=True)
            self.assertEqual(manual.read_bytes(), b"manual backup")
            self.assertFalse((backups / "daily/20000101.dump.age").exists())
            daily = max((backups / "daily").glob("[0-9]" * 8 + ".dump.age"))
            self.assertEqual(daily.read_bytes(), b"archive-content\n")
            self.assertTrue((root / "uploaded").exists())
            self.assertGreater(int((backups / "last-success").read_text()), 0)
