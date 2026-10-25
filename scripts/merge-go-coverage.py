"""Merge source-bound Go profiles, never arithmetic-average percentages."""
import argparse
import glob
import hashlib
import json
from pathlib import Path


def merge_profiles(paths):
    mode = None
    identity = None
    layouts = {}
    blocks = {}
    for path in paths:
        data = path.read_bytes()
        metadata = json.loads(Path(str(path) + ".meta.json").read_text(encoding="utf-8"))
        current = (metadata["revision"], metadata["source_sha256"])
        if hashlib.sha256(data).hexdigest() != metadata["profile_sha256"]:
            raise ValueError("Coverage profile bytes do not match their manifest")
        if identity is not None and current != identity:
            raise ValueError("Cannot merge coverage from different sources or revisions")
        identity = current
        lines = data.decode("utf-8").splitlines()
        current_mode = lines[0] if lines else ""
        if current_mode not in {"mode: atomic", "mode: count", "mode: set"}:
            raise ValueError("Invalid coverage mode")
        if mode is not None and current_mode != mode:
            raise ValueError("Cannot merge different coverage modes")
        mode = current_mode
        file_layouts = {}
        for line in lines[1:]:
            location, statements, hits = line.rsplit(" ", 2)
            statements, hits = int(statements), int(hits)
            if statements < 0 or hits < 0:
                raise ValueError("Negative coverage count")
            name = location.rsplit(":", 1)[0]
            file_layouts.setdefault(name, set()).add((location, statements))
            key = (location, statements)
            blocks[key] = max(blocks.get(key, 0), hits) if mode == "mode: set" else blocks.get(key, 0) + hits
        for name, layout in file_layouts.items():
            if name in layouts and layouts[name] != layout:
                raise ValueError("Coverage block layout changed for " + name)
            layouts[name] = layout
    if mode is None or not blocks:
        raise ValueError("No coverage blocks found")
    return mode + "\n" + "".join(f"{location} {statements} {blocks[(location, statements)]}\n" for location, statements in sorted(blocks))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    parser.add_argument("--expected-profiles", type=int)
    parser.add_argument("profiles", nargs="+")
    options = parser.parse_args()
    paths = sorted({Path(path) for pattern in options.profiles for path in glob.glob(pattern, recursive=True)})
    if not paths:
        raise SystemExit("No coverage profiles matched")
    if options.expected_profiles is not None and len(paths) != options.expected_profiles:
        raise SystemExit("Coverage profile set is incomplete")
    try:
        result = merge_profiles(paths)
    except (ValueError, KeyError, OSError) as error:
        raise SystemExit(str(error)) from error
    output = Path(options.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(result, encoding="utf-8", newline="\n")
    print(f"Merged {len(paths)} source-bound coverage profiles")


if __name__ == "__main__":
    main()
