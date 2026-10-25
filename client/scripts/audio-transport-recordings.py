"""Decode saved receiver WebMs and audit PCM/metadata without modifying media.

python client/scripts/audio-transport-recordings.py artifacts/audio-qa --ffmpeg PATH
Requires only the existing numpy package and FFmpeg/FFprobe. No metric here is
a listening-quality pass/fail result or a network/device latency measurement.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import platform
import subprocess
import sys
import wave

import numpy as np

RATE = 48000
FRAME = 480  # 10 ms RMS envelopes; deliberately no sample-accurate latency claim.
ENGINES = ("rnnoise", "gtcrn", "speex", "deepfilter", "dtln")
FIXTURES = ("clean", "fan", "keyboard", "transient")
TRANSPORTS = ("livekit", "p2p")


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def envelope(samples):
    frames = samples[:len(samples) // FRAME * FRAME].reshape(-1, FRAME)
    return np.sqrt(np.mean(frames * frames, axis=1))


def correlation_lag(reference, received, start, end):
    scores = []
    x = reference[start:end]
    if len(x) < 50 or np.std(x) < 1e-8:
        return {"available": False, "reason": "Insufficient varying reference envelope"}
    x = x - np.mean(x)
    for lag in range(101):
        y = received[start + lag:end + lag]
        if len(y) != len(x):
            scores.append(float("-inf"))
            continue
        y = y - np.mean(y)
        denominator = float(np.linalg.norm(x) * np.linalg.norm(y))
        scores.append(float(np.dot(x, y) / denominator) if denominator else float("-inf"))
    best = int(np.argmax(scores))
    if not np.isfinite(scores[best]):
        return {"available": False, "reason": "No complete finite envelope window"}
    return {"available": True, "lagFrames": best, "offsetMs": best * 10,
            "envelopeCorrelation": scores[best], "atSearchBoundary": best in (0, 100)}


def alignment_and_gaps(reference, received, speech_start, speech_end):
    ref = envelope(reference)
    rec = envelope(received)
    start = speech_start // FRAME
    end = min(speech_end // FRAME, len(ref))
    whole = correlation_lag(ref, rec, start, end)
    middle = (start + end) // 2
    early = correlation_lag(ref, rec, start, middle)
    late = correlation_lag(ref, rec, middle, end)
    stable = all(item.get("available") and item["envelopeCorrelation"] >= 0.85
                 and not item["atSearchBoundary"] for item in (whole, early, late))
    span = max(item["offsetMs"] for item in (whole, early, late)) - min(item["offsetMs"] for item in (whole, early, late)) if all(item.get("available") for item in (whole, early, late)) else None
    usable = stable and span <= 30
    alignment = {"method": "Pearson cross-correlation of non-overlapping 10 ms RMS envelopes", "searchMs": [0, 1000],
                 "resolutionMs": 10, "wholeSpeech": whole, "earlySpeech": early, "lateSpeech": late,
                 "windowOffsetSpanMs": span, "usableForGapScan": usable,
                 "interpretation": "Receiver recording time offset versus offline model WAV, including recorder start, playout and clock differences; not network/device latency."}
    if not usable:
        return alignment, {"available": False, "reason": "Alignment heuristic not met: all three envelope correlations >=0.85, interior lag, offset span <=30 ms required. No gap count inferred."}
    lag = whole["lagFrames"]
    expected = ref[start:end]
    actual = rec[start + lag:end + lag]
    threshold = 10 ** (-45 / 20)
    mask = (expected >= threshold) & (actual == 0.0)
    edges = np.diff(np.r_[False, mask, False].astype(int))
    begins, ends = np.flatnonzero(edges == 1), np.flatnonzero(edges == -1)
    candidates = [{"referenceStartMs": int((start + first) * 10), "recordingStartMs": int((start + first + lag) * 10),
                   "durationMs": int((last - first) * 10)} for first, last in zip(begins, ends)]
    return alignment, {"available": True, "referenceThresholdDbfs": -45, "receiverThreshold": "RMS exactly zero (all decoded frame samples zero)",
                       "frameMs": 10, "expectedActiveFrames": int(np.sum(expected >= threshold)),
                       "strictZeroFrames": int(mask.sum()), "candidateCount": len(candidates), "candidates": candidates,
                       "interpretation": "Diagnostic silence candidates only. Zero candidates does not rule out packet loss, concealed audio, nonzero dropouts, distortion or timing changes."}


def rtp_fields(result, transport):
    diagnostics = result.get("diagnostics", {})
    receiver = diagnostics.get(f"{transport}ReceiverStats")
    sender = diagnostics.get(f"{transport}SenderStats") or []
    if isinstance(receiver, list):
        receiver = next((row for row in receiver if row.get("type") == "inbound-rtp" and row.get("kind", row.get("mediaType")) == "audio"), {})
    receiver = receiver or {}
    feedback = next((row for row in sender if row.get("type") == "remote-inbound-rtp"), {})
    outbound = next((row for row in sender if row.get("type") == "outbound-rtp"), {})
    fields = ("packetsLost", "packetsReceived", "bytesReceived", "concealedSamples", "concealmentEvents", "silentConcealedSamples", "packetsDiscarded", "insertedSamplesForDeceleration", "removedSamplesForAcceleration", "totalSamplesReceived", "totalSamplesDuration", "totalAudioEnergy", "jitter")
    return {"receiver": {field: receiver.get(field) for field in fields},
            "sender": {field: outbound.get(field) for field in ("packetsSent", "bytesSent", "retransmittedPacketsSent")},
            "senderRemoteFeedback": {field: feedback.get(field) for field in ("packetsLost", "fractionLost", "jitter", "roundTripTime")},
            "note": "End-of-run cumulative snapshots, including setup before recording. Null means not exposed. LiveKit sender feedback refers to the server hop, not the subscriber's receive-loss counter."}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path, nargs="?", default=Path(__file__).resolve().parents[2] / "artifacts/audio-qa")
    parser.add_argument("--ffmpeg", required=True, type=Path)
    parser.add_argument("--allow-partial", action="store_true", help="Produce explicitly incomplete diagnostics while recordings are still arriving")
    args = parser.parse_args()
    root = args.directory.resolve()
    ffmpeg = args.ffmpeg.resolve()
    ffprobe = ffmpeg.with_name("ffprobe.exe" if sys.platform == "win32" else "ffprobe")
    chrome_path = root / "chrome-fixtures-report.json"
    offline_path = root / "report.json"
    chrome_bytes, offline_bytes = chrome_path.read_bytes(), offline_path.read_bytes()
    chrome, offline = json.loads(chrome_bytes), json.loads(offline_bytes)
    metadata = {(row["engine"], row["fixture"]): row for row in chrome["results"]}
    recording_metadata = {row["filename"]: row for row in chrome["recordings"]}
    expected = [(engine, fixture, transport, f"remote-{engine}-{fixture}-{transport}.webm") for engine in ENGINES for fixture in FIXTURES for transport in TRANSPORTS]
    missing = [filename for _, _, _, filename in expected if not (root / filename).is_file() or filename not in recording_metadata]
    if missing and not args.allow_partial:
        raise RuntimeError(f"Need all 40 completed recording entries; missing {missing}")
    speech_start = round(offline["leadingNoiseOnlySeconds"] * RATE)
    speech_end = speech_start + round(offline["speechSeconds"] * RATE)
    references = {}
    reference_hashes = {}
    results = []
    for engine, fixture, transport, filename in expected:
        if filename in missing:
            continue
        path = root / filename
        if path.stat().st_size != recording_metadata[filename]["bytes"]:
            raise RuntimeError(f"Recording is incomplete or differs from browser metadata: {filename}")
        key = (engine, fixture)
        reference_path = root / f"{engine}-{fixture}.wav"
        if key not in references:
            with wave.open(str(reference_path), "rb") as reader:
                if (reader.getnchannels(), reader.getsampwidth(), reader.getframerate()) != (1, 2, RATE):
                    raise ValueError("Expected mono PCM16 48 kHz offline reference")
                references[key] = np.frombuffer(reader.readframes(reader.getnframes()), dtype="<i2").astype(np.float64) / 32768
            reference_hashes[reference_path.name] = sha256(reference_path)
        probe = subprocess.run([str(ffprobe), "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_name,sample_rate,channels:format=duration", "-of", "json", str(path)], check=True, capture_output=True, timeout=30)
        stream_metadata = json.loads(probe.stdout)
        decoded = subprocess.run([str(ffmpeg), "-hide_banner", "-loglevel", "error", "-nostdin", "-i", str(path), "-map", "0:a:0", "-ac", "1", "-ar", str(RATE), "-c:a", "pcm_f32le", "-f", "f32le", "pipe:1"], check=True, capture_output=True, timeout=30)
        if len(decoded.stdout) % 4:
            raise ValueError(f"Truncated decoded float32 frame: {filename}")
        samples = np.frombuffer(decoded.stdout, dtype="<f4").astype(np.float64)
        finite = bool(np.isfinite(samples).all())
        row = {"engine": engine, "fixture": fixture, "transport": transport, "file": filename,
               "bytes": path.stat().st_size, "sha256": sha256(path), "sourceStream": stream_metadata,
               "decodedSampleRate": RATE, "decodedChannels": 1, "decodedSamples": len(samples),
               "decodedDurationSeconds": len(samples) / RATE, "finite": finite,
               "samplesAtOrAboveFullScale": int(np.sum(np.abs(samples) >= 1)),
               "peakAbsolute": float(np.max(np.abs(samples))) if len(samples) and finite else None,
               "rmsDbfs": float(20 * np.log10(max(1e-12, np.sqrt(np.mean(samples * samples))))) if len(samples) and finite else None,
               "strictZeroSamples": int(np.sum(samples == 0)),
               "nonzeroSamples": int(np.count_nonzero(samples)),
               "ffmpegDiagnostics": decoded.stderr.decode("utf-8", errors="replace").strip(),
               "browserRequestedRecordingMs": metadata[key].get("recordingDurationMs"),
               "browserSourceClock": metadata[key].get("diagnostics", {}).get("sourceClock"),
               "browserPipelineStatus": metadata[key].get("diagnostics", {}).get(f"{transport}PipelineStatus"),
               "rtp": rtp_fields(metadata[key], transport)}
        if finite and len(samples):
            row["alignment"], row["gapCandidates"] = alignment_and_gaps(references[key], samples, speech_start, speech_end)
        else:
            row["gapCandidates"] = {"available": False, "reason": "No finite decoded audio"}
        results.append(row)
    version = subprocess.run([str(ffmpeg), "-version"], check=True, capture_output=True, text=True, timeout=10).stdout.splitlines()[0]
    limits = [
        "These are local loopback LiveKit and direct-P2P receiver recordings from one Turkish sentence and synthetic noises. Capture constraints are simulated on generated tracks; no microphone, browser capture DSP effectiveness or real-world network quality is established.",
        "FFmpeg decodes the first audio stream to mono float32 at 48 kHz; stereo recordings are downmixed. Finite samples, duration and full-scale counts are file-integrity observations, not subjective quality verdicts. Opus decoding can produce overshoots; counts are reported without clipping or normalization.",
        "Recording duration follows actual MediaRecorder/audio time. The probe's requested duration uses host timers, so scheduling and recorder start/stop differences can make the file longer. These durations are not round-trip or device latency.",
        "Alignment is a bounded 0..1000 ms, 10 ms-resolution RMS-envelope comparison against the matching offline engine output. Whole, early and late speech windows are reported. Browser resampling, worker buffering, Opus, playout, MediaRecorder origins and clock drift can change alignment.",
        "Gap scanning is omitted when the explicit alignment heuristic is uncertain. Otherwise a candidate requires reference RMS >= -45 dBFS and receiver RMS exactly zero for a 10 ms frame. This diagnostic does not detect every dropout or distinguish codec concealment, model changes and packet loss; zero candidates is not proof of gap-free speech.",
        "RTP counters are cumulative end snapshots, including setup before the recording. Missing SDK counters remain null. Concealment can occur with zero reported packet loss because of timing/playout behavior. Muted renderer audio-energy counters can remain zero despite nonzero decoded PCM.",
        "No listening-quality score or aggregate quality pass/fail is computed. Original WAV and WebM files are read only. Existing STOI/ESTOI results refer to offline model outputs, not these encoded transport recordings.",
    ]
    summary = {"expectedRecordings": 40, "auditedRecordings": len(results), "completeMatrix": not missing and len(results) == 40,
               "missing": missing, "finiteRecordings": sum(row["finite"] for row in results),
               "nonemptyRecordings": sum(row["decodedSamples"] > 0 for row in results),
               "recordingsWithFullScaleSamples": sum(row["samplesAtOrAboveFullScale"] > 0 for row in results),
               "durationRangeSeconds": [min(row["decodedDurationSeconds"] for row in results), max(row["decodedDurationSeconds"] for row in results)] if results else None,
               "gapScansAvailable": sum(row["gapCandidates"]["available"] for row in results),
               "strictZeroGapCandidates": sum(row["gapCandidates"].get("candidateCount", 0) for row in results)}
    report = {"createdAt": datetime.now(timezone.utc).isoformat(), "environment": {"python": sys.version, "numpy": np.__version__, "platform": platform.platform(), "ffmpeg": version},
              "limitations": limits, "summary": summary,
              "provenance": {"chromeReport": {"file": chrome_path.name, "sha256": hashlib.sha256(chrome_bytes).hexdigest()},
                             "offlineReport": {"file": offline_path.name, "sha256": hashlib.sha256(offline_bytes).hexdigest()},
                             "offlineWavSha256": reference_hashes, "scriptSha256": sha256(Path(__file__))},
              "results": results}
    (root / "receiver-audit.json").write_text(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    lines = ["# Receiver recording audit", "", f"Audited {len(results)} / 40 expected receiver recordings. Complete matrix: {summary['completeMatrix']}.", "", *[f"- {item}" for item in limits], "",
             "| Engine | Fixture | Transport | Duration (s) | Finite | Full-scale samples | Recording offset (ms) / envelope r | Strict-zero candidates | Receiver lost / concealed samples |",
             "| --- | --- | --- | ---: | --- | ---: | --- | --- | --- |"]
    for row in results:
        aligned = row.get("alignment", {}).get("wholeSpeech", {})
        lag = f"{aligned['offsetMs']} / {aligned['envelopeCorrelation']:.3f}" if aligned.get("available") else "unavailable"
        gaps = str(row["gapCandidates"]["candidateCount"]) if row["gapCandidates"]["available"] else "not assessed (alignment)"
        received = row["rtp"]["receiver"]
        loss = received["packetsLost"] if received["packetsLost"] is not None else "not exposed"
        concealed = received["concealedSamples"] if received["concealedSamples"] is not None else "not exposed"
        lines.append(f"| {row['engine']} | {row['fixture']} | {row['transport']} | {row['decodedDurationSeconds']:.3f} | {row['finite']} | {row['samplesAtOrAboveFullScale']} | {lag} | {gaps} | {loss} / {concealed} |")
    lines.extend(["", "See [receiver-audit.json](receiver-audit.json) for exact PCM counts, source codecs/channels, file hashes, alignment reliability checks, each gap candidate, cumulative RTP feedback/concealment counters, actual source clocks and provenance.", ""])
    (root / "receiver-audit.md").write_text("\n".join(lines), encoding="utf-8")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
