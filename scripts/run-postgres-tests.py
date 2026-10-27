"""Run PostgreSQL contracts and refuse a green result with skipped tests."""

import json
import os
import re
from pathlib import Path
import subprocess
import sys
from urllib.parse import urlparse

REQUIRED_PACKAGES = {
    "github.com/argeinfina/hichat",
    "github.com/argeinfina/hichat/repository",
    "github.com/argeinfina/hichat/database",
}
REQUIRED_SERVER_POSTGRES_TEST = "TestPurgeExpiredNotificationsPostgres"


def main():
    dsn = os.environ.get("HICHAT_TEST_POSTGRES_DSN", "")
    parsed = urlparse(dsn)
    if parsed.scheme not in {"postgres", "postgresql"} or parsed.hostname not in {"localhost", "127.0.0.1"}:
        raise SystemExit("PostgreSQL tests require an isolated loopback HICHAT_TEST_POSTGRES_DSN")
    root = Path(__file__).resolve().parents[1]
    # TLS uses its separate certificate-authenticated fixture. The server
    # package includes the PostgreSQL notification-retention test. All server,
    # repository and database tests must execute in this lane; a missing DSN
    # must never look like PASS.
    command = ["go", "test", "-json", "-count=1", "-timeout=15m", ".", "./repository", "./database",
               "-skip", "^TestOpenPostgresInlinePEMReconnect$"]
    process = subprocess.Popen(command, cwd=root / "server", stdout=subprocess.PIPE, text=True)
    skipped = []
    completed = set()
    postgres_retention_passed = False
    invalid_output = False
    for line in process.stdout:
        # Persist ordinary go-test output without printing database credentials.
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            print("Unexpected non-JSON output from go test", file=sys.stderr)
            invalid_output = True
            continue
        if event.get("Action") == "skip" and event.get("Test"):
            # The server package contains unrelated opt-in tests that may
            # legitimately skip (for example, a provider-specific lifecycle
            # test). Every skip in repository/database remains forbidden, and
            # the PostgreSQL retention contract itself must always execute.
            if (event.get("Package") != "github.com/argeinfina/hichat"
                    or event.get("Test") == REQUIRED_SERVER_POSTGRES_TEST):
                skipped.append(event["Test"])
        if (event.get("Action") == "pass"
                and event.get("Package") == "github.com/argeinfina/hichat"
                and event.get("Test") == REQUIRED_SERVER_POSTGRES_TEST):
            postgres_retention_passed = True
        if event.get("Action") == "pass" and not event.get("Test"):
            completed.add(event.get("Package"))
        if event.get("Action") in {"pass", "fail", "skip"}:
            print(json.dumps({key: event[key] for key in ("Action", "Package", "Test", "Elapsed") if key in event}), flush=True)
        elif event.get("Action") == "output":
            # Repository fixtures use synthetic records, but database driver
            # errors may contain a DSN; never echo it in CI.
            output = event.get("Output", "").replace(dsn, "[test-database]")
            output = re.sub(r"\bpostgres(?:ql)?://\S+", "[test-database]", output)
            if not output.startswith(("=== ", "--- PASS", "--- SKIP")):
                print(output, end="", flush=True)
    code = process.wait()
    if skipped:
        print("Required PostgreSQL tests skipped: " + ", ".join(skipped), file=sys.stderr)
    missing_packages = REQUIRED_PACKAGES - completed
    if missing_packages:
        print("Required PostgreSQL packages did not complete: " + ", ".join(sorted(missing_packages)), file=sys.stderr)
    if not postgres_retention_passed:
        print(f"Required PostgreSQL test did not pass: {REQUIRED_SERVER_POSTGRES_TEST}", file=sys.stderr)
    return code or int(bool(skipped) or bool(missing_packages) or not postgres_retention_passed or invalid_output)


if __name__ == "__main__":
    raise SystemExit(main())
