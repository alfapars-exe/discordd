import unittest
from audit_profile_latencies import audit


def capture():
    lines = []
    for size in (0, 1, 100, 1001):
        for bulk in ("false", "true"):
            for _ in range(9):
                lines += ["operationLatenciesNs=[1]", "operationLatenciesNs=[" + " ".join(str(n) for n in range(30, 0, -1)) + "]",
                          f"BenchmarkGroupPublicProfilePopulation/users={size}/bulk={bulk}-32 30 16 ns/op 15 p50-ns/op 29 p95-ns/op 0 pool-wait-ns/op"]
    return "\n".join(lines + ["PASS", "ok repository"])


class ProfileLatencyAuditTests(unittest.TestCase):
    def test_all_cases_and_calibration_exclusion(self):
        result = audit(capture())
        self.assertEqual(result["result"], "PASS")
        self.assertEqual(len(result["cases"]), 8)
        self.assertEqual(result["cases"]["users=1001/bulk=true"][0]["p95Ns"], 29)

    def test_partial_incorrect_and_failed_runs_are_rejected(self):
        for text in [capture().replace("29 p95", "30 p95", 1),
                     capture().replace("operationLatenciesNs=[30 29", "operationLatenciesNs=[29", 1),
                     capture().replace("30 16 ns/op", "29 16 ns/op", 1),
                     capture().replace("PASS", "FAIL"),
                     capture().replace("0 pool-wait", "-1 pool-wait", 1),
                     capture() + "\n--- FAIL: test", "PASS"]:
            with self.subTest(case=text[:60]), self.assertRaises(ValueError):
                audit(text)
