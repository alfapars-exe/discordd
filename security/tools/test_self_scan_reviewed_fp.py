"""Integration regressions for exact-source self-scan FP review records."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from security.tools.self_scan_reviewed_fp import parse_grep_hit


TOOLS = Path(__file__).resolve().parent
SCANNER = TOOLS / "self-scan.sh"
HELPER = TOOLS / "self_scan_reviewed_fp.py"
MANIFEST_NAME = "self-scan-reviewed-falsepositives.json"


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def reviewed_entry(root: Path, rule: str, rel: str, matching_line: str, reason: str, proof: str) -> dict[str, str]:
    content = (root / rel).read_bytes()
    return {
        "rule": rule,
        "path": rel,
        "file_sha256": digest(content.replace(b"\r\n", b"\n")),
        "line_sha256": digest(matching_line.strip().encode("utf-8")),
        "reason": reason,
        "proof_ref": proof,
    }


class SelfScanReviewedFPTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        original_cwd = Path.cwd()
        # Cleanup is LIFO, so restore the runner cwd before TemporaryDirectory
        # attempts to remove its tree on Windows.
        self.addCleanup(os.chdir, original_cwd)
        self.root = Path(self.temp.name)
        self.tools = self.root / "security" / "tools"
        self.tools.mkdir(parents=True)
        shutil.copy2(SCANNER, self.tools / SCANNER.name)
        shutil.copy2(HELPER, self.tools / HELPER.name)
        self.manifest = self.tools / MANIFEST_NAME
        self.sources: dict[str, str] = {
            "client/src/fixture.test.ts": 'area.innerHTML = "<div></div>";\n',
            "client/src/stores/authStore.ts": 'localStorage.setItem(manualStatusStorageKey(userId), status);\n',
            "server/repository/bound_values_test.go": 'db.ExecContext(ctx, "UPDATE events SET created_at=?", fmt.Sprintf("2026-%02d", month))\n',
            "server/repository/static_query.go": 'db.QueryContext(ctx, selectColumns+where+order, args...)\n',
            "server/pkg/crypto/totp.go": '"crypto/sha1"\n',
        }
        for rel, source in self.sources.items():
            path = self.root / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(source, encoding="utf-8")
        rule_by_path = {
            "client/src/fixture.test.ts": "js.innerhtml-assignment",
            "client/src/stores/authStore.ts": "js.webstorage-sensitive-key",
            "server/repository/bound_values_test.go": "go.sql-sprintf",
            "server/repository/static_query.go": "go.sql-concat",
            "server/pkg/crypto/totp.go": "go.weak-hash",
        }
        self.entries = []
        for rel, source in self.sources.items():
            self.entries.append(
                reviewed_entry(
                    self.root,
                    rule_by_path[rel],
                    rel,
                    source.rstrip("\n"),
                    "Test-only/static query or standards-required HMAC shape; inputs remain DOM-built, bound, or fixed.",
                    "test_self_scan_reviewed_fp.py::test_exact_reviewed_shapes_are_review_queue_only",
                )
            )
        self.write_manifest()

    def write_manifest(self) -> None:
        self.manifest.write_text(
            json.dumps({"version": 1, "entries": self.entries}, indent=2) + "\n",
            encoding="utf-8",
        )

    def scan(self) -> subprocess.CompletedProcess[str]:
        configured_bash = os.environ.get("SELF_SCAN_TEST_BASH")
        git_bash = Path("C:/Program Files/Git/bin/bash.exe")
        bash = configured_bash or (str(git_bash) if git_bash.is_file() else shutil.which("bash"))
        if not bash:
            self.skipTest("bash is required for self-scan integration regressions")
        env = os.environ.copy()
        env["PYTHONDONTWRITEBYTECODE"] = "1"
        # Native Git Bash can use the current Windows Python directly. This
        # documents the same override supported for interactive local scans.
        env["SELF_SCAN_PYTHON"] = sys.executable.replace("\\", "/")
        return subprocess.run(
            [bash, "security/tools/self-scan.sh", ".", "scan-review.txt"],
            cwd=self.root,
            env=env,
            text=True,
            encoding="utf-8",
            errors="replace",
            capture_output=True,
            check=False,
        )

    def test_exact_reviewed_shapes_are_review_queue_only(self) -> None:
        result = self.scan()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("✅ BLOK deseni: 0 eşleşme", result.stdout)
        review = (self.root / "scan-review.txt").read_text(encoding="utf-8")
        self.assertEqual(review.count("reviewed self-scan FP:"), len(self.entries))
        for entry in self.entries:
            self.assertIn(entry["proof_ref"], review)

    def test_unexpected_token_storage_sql_and_sha1_remain_blocking(self) -> None:
        (self.root / "client/src/unsafe.ts").write_text(
            'localStorage.setItem("auth-token", token);\n', encoding="utf-8"
        )
        (self.root / "server/repository/unsafe.go").write_text(
            'db.QueryContext(ctx, query + userInput)\n',
            encoding="utf-8",
        )
        (self.root / "server/repository/unsafe_sprintf.go").write_text(
            'db.QueryContext(ctx, fmt.Sprintf("SELECT * FROM users WHERE name=%s", userInput))\n',
            encoding="utf-8",
        )
        (self.root / "server/pkg/crypto/unsafe.go").write_text(
            '"crypto/sha1"\n', encoding="utf-8"
        )
        result = self.scan()
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        for label in (
            "Web storage'da hassas veri",
            "SQL string concat",
            "SQL Sprintf ile kuruluyor",
            "zayıf hash (md5/sha1)",
        ):
            self.assertIn(f"❌ BLOK: {label}", result.stdout)
        self.assertIn('localStorage.setItem("auth-token", token)', result.stdout)
        self.assertIn("query + userInput", result.stdout)
        self.assertIn("fmt.Sprintf(\"SELECT * FROM users WHERE name=%s\", userInput)", result.stdout)
        self.assertIn('"crypto/sha1"', result.stdout)

    def test_any_reviewed_source_change_invalidates_manifest_and_blocks(self) -> None:
        rel = "server/repository/static_query.go"
        (self.root / rel).write_text("db.QueryContext(ctx, selectColumns+where, args...) // changed\n", encoding="utf-8")
        result = self.scan()
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("stale source hash", result.stderr)
        self.assertIn("manifest invalid or stale", result.stdout)

    def test_lf_and_crlf_checkouts_share_reviewed_source_hash(self) -> None:
        for rel, source in self.sources.items():
            (self.root / rel).write_bytes(source.replace("\n", "\r\n").encode("utf-8"))
        result = self.scan()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("valid (5 exact source records)", result.stdout)

    def test_grep_hit_parser_preserves_colons_in_source_text(self) -> None:
        parsed = parse_grep_hit('./server/query.go:7:query := fmt.Sprintf("host:%d", port)')
        self.assertEqual(parsed, ("./server/query.go", 7, 'query := fmt.Sprintf("host:%d", port)'))

    def test_malformed_manifest_fails_closed(self) -> None:
        self.manifest.write_text('{"version": 1, "entries": null}\n', encoding="utf-8")
        result = self.scan()
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("manifest entries must be a list", result.stderr)


if __name__ == "__main__":
    unittest.main()
