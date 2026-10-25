"""Parser regressions for blocker calls carrying exact reviewed-hit IDs."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from security.tools.sync_agent_guardrail import parse_self_scan


class ReviewedCallParserTests(unittest.TestCase):
    def parse(self, source: str) -> list[dict[str, str]]:
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "self-scan.sh"
            path.write_text(source, encoding="utf-8")
            return parse_self_scan(path)

    def test_reviewed_blockers_keep_id_pattern_label_language_and_block_class(self) -> None:
        rules = self.parse(
            "blok_reviewed_go \"SQL string concat\" \"go.sql-concat\" "
            "'\\.(Query|QueryRow|Exec)(Context)?\\([^)]*[A-Za-z_]+\\s*\\+'\n"
            "blok_reviewed_go \"zayıf hash (md5/sha1)\" \"go.weak-hash\" "
            "'\"crypto/(md5|sha1)\"'\n"
        )
        by_id = {
            rule["reviewed_rule_id"]: rule
            for rule in rules
            if "reviewed_rule_id" in rule
        }
        self.assertEqual(set(by_id), {"go.sql-concat", "go.weak-hash"})
        self.assertEqual(by_id["go.sql-concat"]["label"], "SQL string concat")
        self.assertEqual(by_id["go.sql-concat"]["klass"], "BLOK")
        self.assertEqual(by_id["go.sql-concat"]["lang"], "go")
        self.assertEqual(by_id["go.sql-concat"]["regex"], r"\.(Query|QueryRow|Exec)(Context)?\([^)]*[A-Za-z_]+\s*\+")
        self.assertEqual(by_id["go.weak-hash"]["klass"], "BLOK")
        self.assertEqual(by_id["go.weak-hash"]["regex"], r'"crypto/(md5|sha1)"')

    def test_unknown_reviewed_id_fails_closed(self) -> None:
        with self.assertRaisesRegex(ValueError, "not mapped"):
            self.parse('blok_reviewed_go "SQL string concat" "go.unknown" \'query\\+\'\n')

    def test_reviewed_id_cannot_be_relabelled(self) -> None:
        with self.assertRaisesRegex(ValueError, "mismatch"):
            self.parse('blok_reviewed_go "shell -c ile komut" "go.sql-concat" \'query\\+\'\n')

    def test_malformed_reviewed_call_fails_closed(self) -> None:
        with self.assertRaisesRegex(ValueError, "malformed reviewed"):
            self.parse('blok_reviewed_go "SQL string concat" "go.sql-concat"\n')


if __name__ == "__main__":
    unittest.main()
