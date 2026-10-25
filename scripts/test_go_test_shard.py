import importlib.util
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("go-test-shard.py")
SPEC = importlib.util.spec_from_file_location("go_test_shard", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


class PartitionTests(unittest.TestCase):
    def test_parse_includes_tests_examples_and_fuzz_seeds(self):
        names = MODULE.parse_test_names(
            "TestAlpha\nExampleAlpha\nFuzzAlpha\nBenchmarkAlpha\nok example/pkg [no tests to run]\n"
        )
        self.assertEqual(names, ["TestAlpha", "ExampleAlpha", "FuzzAlpha"])

    def test_partition_is_deterministic_balanced_and_complete(self):
        names = [f"TestCase{i:03}" for i in range(103)]
        first = MODULE.partition(names, 8)
        second = MODULE.partition(list(reversed(names)), 8)
        self.assertEqual(first, second)
        self.assertEqual(sorted(name for shard in first for name in shard), sorted(names))
        self.assertEqual(len(set(name for shard in first for name in shard)), len(names))
        self.assertLessEqual(max(map(len, first)) - min(map(len, first)), 1)

    def test_shard_count_must_be_positive(self):
        with self.assertRaises(ValueError):
            MODULE.partition(["TestOne"], 0)


if __name__ == "__main__":
    unittest.main()
