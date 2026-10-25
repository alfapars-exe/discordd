import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("merge_coverage", Path(__file__).with_name("merge-go-coverage.py"))
coverage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(coverage)


class CoverageMergeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)

    def profile(self, name, content, source="source", revision="revision"):
        path = Path(self.temp.name) / name
        path.write_bytes(content.encode())
        Path(str(path) + ".meta.json").write_text(json.dumps({
            "revision": revision, "source_sha256": source,
            "profile_sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        }))
        return path

    def test_merges_hits_and_retains_zero_hit_blocks(self):
        first = self.profile("a.out", "mode: atomic\npkg/a.go:1.1,2.2 2 0\npkg/a.go:3.1,4.2 1 0\n")
        second = self.profile("b.out", "mode: atomic\npkg/a.go:1.1,2.2 2 3\npkg/a.go:3.1,4.2 1 0\n")
        self.assertEqual(coverage.merge_profiles([first, second]), "mode: atomic\npkg/a.go:1.1,2.2 2 3\npkg/a.go:3.1,4.2 1 0\n")

    def test_rejects_different_source_or_revision(self):
        first = self.profile("a.out", "mode: atomic\npkg/a.go:1.1,2.2 1 1\n")
        for source, revision in [("changed", "revision"), ("source", "changed")]:
            with self.subTest(source=source, revision=revision):
                second = self.profile("b.out", first.read_text(), source, revision)
                with self.assertRaisesRegex(ValueError, "different sources"):
                    coverage.merge_profiles([first, second])

    def test_rejects_tampered_profile_and_inconsistent_layout(self):
        first = self.profile("a.out", "mode: atomic\npkg/a.go:1.1,2.2 1 1\n")
        second = self.profile("b.out", "mode: atomic\npkg/a.go:1.1,3.2 1 1\n")
        with self.assertRaisesRegex(ValueError, "layout changed"):
            coverage.merge_profiles([first, second])
        first.write_text(first.read_text() + "pkg/a.go:4.1,5.2 1 0\n")
        with self.assertRaisesRegex(ValueError, "manifest"):
            coverage.merge_profiles([first])

    def test_rejects_empty_profiles_and_mixed_modes(self):
        with self.assertRaisesRegex(ValueError, "No coverage"):
            coverage.merge_profiles([])
        first = self.profile("a.out", "mode: count\npkg/a.go:1.1,2.2 1 1\n")
        second = self.profile("b.out", "mode: set\npkg/a.go:1.1,2.2 1 1\n")
        with self.assertRaisesRegex(ValueError, "different coverage modes"):
            coverage.merge_profiles([first, second])
