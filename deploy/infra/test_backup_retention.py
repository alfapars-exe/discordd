import datetime as dt
import json
import pathlib
import runpy
import unittest
from unittest.mock import patch

SCRIPT = str(pathlib.Path(__file__).with_name("backup-retention.py"))

class RetentionTests(unittest.TestCase):
    def test_missing_latest_never_deletes(self):
        with patch("subprocess.check_output", return_value=b"[]"), patch("subprocess.run") as remove:
            with patch("sys.argv", [SCRIPT, "hourly/latest", "daily/latest"]), self.assertRaises(SystemExit):
                runpy.run_path(SCRIPT)
            remove.assert_not_called()

    def test_only_owned_expired_archives_are_removed(self):
        now = dt.datetime.now(dt.timezone.utc)
        hourly = "hourly/" + now.strftime("%Y%m%dT%H%M%SZ") + ".dump.age"
        daily = "daily/" + now.strftime("%Y%m%d") + ".dump.age"
        paths = [hourly, daily, "hourly/20200101T000000Z.dump.age", "uploads/20200101.dump.age", "daily/notes.txt"]
        rows = [{"type": "file", "path": name, "size": 50} for name in paths]
        with patch("subprocess.check_output", return_value=json.dumps(rows).encode()), patch("subprocess.run") as remove:
            with patch("sys.argv", [SCRIPT, hourly, daily]):
                runpy.run_path(SCRIPT)
            self.assertEqual(remove.call_count, 1)
            self.assertIn("infinayazilim/hichat-db-backups/hourly/20200101T000000Z.dump.age", remove.call_args.args[0])

if __name__ == "__main__":
    unittest.main()
