"""Reject invalid UTF-8 in first-party tracked/untracked source text."""

from pathlib import Path
import subprocess
import sys

EXTENSIONS = {".go", ".ts", ".tsx", ".js", ".mjs", ".json", ".yaml", ".yml",
              ".py", ".cpp", ".h", ".kt", ".java", ".swift", ".sql", ".md",
              ".html", ".css", ".sh", ".ps1"}


def main():
    root = Path(__file__).resolve().parents[1]
    names = subprocess.check_output(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], cwd=root
    ).decode("utf-8").split("\0")
    checked = 0
    failures = []
    for name in sorted(set(names)):
        path = root / name
        if path.suffix not in EXTENSIONS or not path.is_file():
            continue
        if name.startswith(("artifacts/", "client/public/", "implementation/verification/")):
            continue
        data = path.read_bytes()
        checked += 1
        try:
            data.decode("utf-8", errors="strict")
        except UnicodeDecodeError as error:
            line = data[:error.start].count(b"\n") + 1
            failures.append(f"{name}:{line}: invalid UTF-8 at byte {error.start}")
    for failure in failures:
        print(failure, file=sys.stderr)
    print(f"UTF-8: {checked} source files checked, {len(failures)} invalid")
    return bool(failures)


if __name__ == "__main__":
    raise SystemExit(main())
