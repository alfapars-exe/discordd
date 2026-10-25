"""Reference-based STOI/ESTOI for saved offline audio QA, without editing WAVs.

Install isolated dependencies, from the repository root:
  python -m pip install --target artifacts/audio-qa/python-deps --no-deps \
    --only-binary=:all: --report artifacts/audio-qa/python-deps-install.json \
    pystoi==0.4.1 scipy==1.15.3
The existing Python environment must provide numpy (this run uses 2.3.5).
Run: python client/scripts/audio-intelligibility.py [artifacts/audio-qa]
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import importlib.metadata
import json
from pathlib import Path
import platform
import sys
import warnings
import wave


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", nargs="?", type=Path,
                        default=Path(__file__).resolve().parents[2] / "artifacts/audio-qa")
    parser.add_argument("--deps", type=Path, help="Isolated scipy/pystoi installation directory")
    args = parser.parse_args()
    root = args.directory.resolve()
    dependencies = (args.deps or root / "python-deps").resolve()
    sys.path.insert(0, str(dependencies))
    import numpy as np
    import scipy
    import pystoi
    from pystoi import stoi

    versions = {name: importlib.metadata.version(name) for name in ("numpy", "scipy", "pystoi")}
    if versions["scipy"] != "1.15.3" or versions["pystoi"] != "0.4.1":
        raise RuntimeError("Use pinned scipy==1.15.3 and pystoi==0.4.1 in --deps")
    for module in (scipy, pystoi):
        if not Path(module.__file__).resolve().is_relative_to(dependencies):
            raise RuntimeError(f"{module.__name__} must come from the isolated --deps directory")

    report_path = root / "report.json"
    source_report = json.loads(report_path.read_text(encoding="utf-8-sig"))
    rate = source_report["sampleRate"]
    start = round(source_report["leadingNoiseOnlySeconds"] * rate)
    end = start + round(source_report["speechSeconds"] * rate)
    fixture_names = ("clean", "fan", "keyboard", "transient")
    inputs = {}
    files = {}

    def read_audio(relative: str):
        path = root / relative
        with wave.open(str(path), "rb") as reader:
            if reader.getnchannels() != 1 or reader.getsampwidth() != 2 or reader.getframerate() != rate:
                raise ValueError(f"Expected mono PCM16 {rate} Hz: {relative}")
            values = np.frombuffer(reader.readframes(reader.getnframes()), dtype="<i2").astype(np.float64) / 32768
        if not np.isfinite(values).all():
            raise ValueError(f"Nonfinite samples: {relative}")
        files[relative] = {"bytes": path.stat().st_size, "sha256": sha256(path), "samples": len(values)}
        return values

    for fixture in fixture_names:
        relative = f"inputs/{fixture}.wav"
        inputs[fixture] = read_audio(relative)
        expected = source_report.get("fixtureFiles", {}).get(fixture, {}).get("sha256")
        if expected and files[relative]["sha256"] != expected:
            raise ValueError(f"Input differs from the report used for alignment: {relative}")
    reference = inputs["clean"][start:end]
    if len(reference) != end - start or np.max(np.abs(reference)) == 0:
        raise ValueError("Missing speech reference")
    seed = 20261023

    def measure(degraded, lag_ms: float):
        lag = round(lag_ms * rate / 1000)
        if abs(lag_ms) > 250 or start + lag < 0 or end + lag > len(degraded):
            raise ValueError(f"Invalid saved lag or insufficient audio: {lag_ms} ms")
        aligned = degraded[start + lag:end + lag]
        if aligned.shape != reference.shape:
            raise ValueError("Reference and aligned degradation must have equal length")
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            np.random.seed(seed)
            standard = float(stoi(reference, aligned, rate, extended=False))
            np.random.seed(seed)
            extended = float(stoi(reference, aligned, rate, extended=True))
        if not np.isfinite([standard, extended]).all():
            raise ValueError("Nonfinite intelligibility metric")
        return {"stoi": standard, "estoi": extended, "lagMs": lag_ms, "lagSamples": lag,
                "referenceStartSample": start, "degradedStartSample": start + lag,
                "comparedSamples": len(reference), "comparedSeconds": len(reference) / rate,
                "warnings": [str(item.message) for item in caught]}

    baselines = [{"fixture": fixture, "inputFile": f"inputs/{fixture}.wav", **measure(inputs[fixture], 0)}
                 for fixture in fixture_names]
    by_fixture = {row["fixture"]: row for row in baselines}
    if not np.allclose([baselines[0]["stoi"], baselines[0]["estoi"]], [1, 1], atol=1e-8, rtol=0):
        raise ValueError("Clean-reference identity check failed")
    results = []
    for engine in source_report["results"]:
        for record in engine.get("results", []):
            fixture = record["fixture"]
            output = read_audio(record["outputFile"])
            measured = measure(output, record["outputLag"]["milliseconds"])
            results.append({"engine": engine["engine"], "fixture": fixture, "outputFile": record["outputFile"],
                            **measured, "deltaStoiVsNoisyInput": measured["stoi"] - by_fixture[fixture]["stoi"],
                            "deltaEstoiVsNoisyInput": measured["estoi"] - by_fixture[fixture]["estoi"]})
    if len(results) != 20 or len({(r["engine"], r["fixture"]) for r in results}) != 20:
        raise ValueError("Expected all 20 unique outputs, without selecting favorable cases")

    install_report_path = root / "python-deps-install.json"
    install_report = json.loads(install_report_path.read_text(encoding="utf-8"))
    packages = [{"name": item["metadata"]["name"], "version": item["metadata"]["version"],
                 "wheelUrl": item["download_info"]["url"],
                 "wheelSha256": item["download_info"]["archive_info"]["hashes"]["sha256"]}
                for item in install_report["install"]]
    pystoi_root = Path(pystoi.__file__).parent
    limitations = [
        "One speaker reading one Turkish sentence, originally 16 kHz, with synthetic noises. Scores do not establish performance across speakers, languages, microphones or real environments.",
        "STOI and ESTOI are reference-based objective intelligibility proxies, not word-recognition percentages, listening tests, overall sound quality or a release pass/fail criterion. Higher scores are not proof of universal superiority.",
        "Only the original 14.16-second speech region is scored. The three-second leading and two-second trailing noise-only padding are excluded; pystoi additionally removes silent frames using the clean reference.",
        "Alignment uses each output's existing waveform-correlation lag from report.json, rounded to the nearest sample. No per-metric lag search, amplitude normalization or favorable segment selection is applied.",
        "pystoi internally resamples to 10 kHz and evaluates speech-band envelopes; these metrics cannot establish preservation of frequencies above 8 kHz or justify the 16 kHz modes' full-band fidelity.",
        "All inputs and model outputs are saved PCM16 WAVs. These are model-only offline outputs, without the energy gate, microphone processing, browser queues or LiveKit/P2P encoding. Quantization may influence quiet frames.",
        "All 20 engine/fixture combinations and unprocessed input baselines are reported, including degradation. Negative deltas are preserved; no score threshold is used to declare success.",
    ]
    provenance = {
        "implementation": "https://github.com/mpariente/pystoi",
        "pystoiRelease": "https://pypi.org/project/pystoi/0.4.1/",
        "scipyRelease": "https://pypi.org/project/scipy/1.15.3/",
        "sourceReport": {"file": "report.json", "sha256": sha256(report_path)},
        "sourceRecording": source_report["source"], "files": files,
        "packages": packages,
        "pystoiSourceHashes": {name: sha256(pystoi_root / name) for name in ("stoi.py", "utils.py")},
        "numpyInstalledRecordSha256": hashlib.sha256(importlib.metadata.distribution("numpy").read_text("RECORD").encode()).hexdigest(),
        "scriptSha256": sha256(Path(__file__)),
    }
    report = {"createdAt": datetime.now(timezone.utc).isoformat(), "environment": {"python": sys.version, "platform": platform.platform(), **versions},
              "sampleRate": rate, "metricInternalSampleRate": 10000, "normalizationNoiseSeed": seed,
              "alignment": "degraded[speechStart + round(savedLagMs * fs / 1000) : speechEnd + lag] vs clean[speechStart:speechEnd]",
              "limitations": limitations, "provenance": provenance, "baselines": baselines, "results": results}
    (root / "intelligibility.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    lines = ["# STOI / ESTOI — Turkish speech fixture", "", "Reference-based objective proxies; this is not a human listening test or a quality pass/fail verdict.", "",
             "Method: [pystoi 0.4.1](https://pypi.org/project/pystoi/0.4.1/) ([official implementation](https://github.com/mpariente/pystoi)), with [SciPy 1.15.3](https://pypi.org/project/scipy/1.15.3/).",
             "", *[f"- {item}" for item in limitations], "", "## Unprocessed input baselines", "",
             "| Fixture | STOI | ESTOI |", "| --- | ---: | ---: |"]
    lines.extend(f"| {row['fixture']} | {row['stoi']:.4f} | {row['estoi']:.4f} |" for row in baselines)
    lines.extend(["", "## Every engine output", "", "Deltas are against the matching unprocessed fixture. No ranking or success threshold is applied.", "",
                  "| Engine | Fixture | Lag (ms) | STOI | ESTOI | Δ STOI | Δ ESTOI |",
                  "| --- | --- | ---: | ---: | ---: | ---: | ---: |"])
    lines.extend(f"| {row['engine']} | {row['fixture']} | {row['lagMs']:.3f} | {row['stoi']:.4f} | {row['estoi']:.4f} | {row['deltaStoiVsNoisyInput']:+.4f} | {row['deltaEstoiVsNoisyInput']:+.4f} |" for row in results)
    lines.extend(["", "Every comparison uses the same complete 14.16-second reference segment after the saved latency alignment. Clean/clean identity was checked against 1.0 for both metrics. Fixed RNG seed makes pystoi's tiny ESTOI normalization perturbations repeatable.", "",
                  "See [intelligibility.json](intelligibility.json) for exact values, warnings, source provenance, SHA-256 hashes of all 24 WAV files and the alignment report, package wheel URLs/hashes, implementation hashes and runtime versions. Existing WAV files are not modified.", ""])
    (root / "intelligibility.md").write_text("\n".join(lines), encoding="utf-8")
    print(json.dumps({"baselines": [{k: row[k] for k in ("fixture", "stoi", "estoi")} for row in baselines],
                      "results": [{k: row[k] for k in ("engine", "fixture", "stoi", "estoi", "deltaStoiVsNoisyInput", "deltaEstoiVsNoisyInput")} for row in results]}, indent=2))


if __name__ == "__main__":
    main()
