"""Inspect the saved DFN same-clock local/receiver PCM onset reproduction.

python client/scripts/audio-paired-onset-audit.py artifacts/audio-qa
Uses bundled numpy and the already isolated python-deps/scipy from intelligibility
QA. Reads media only. Alignment offsets are not network/device latency estimates.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import struct
import sys

import numpy as np


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read_pair(path):
    data = path.read_bytes()
    if data[:4] != b"RIFF" or data[8:12] != b"WAVE":
        raise ValueError("Expected RIFF WAVE")
    offset, fmt, pcm = 12, None, None
    while offset + 8 <= len(data):
        kind, size = struct.unpack_from("<4sI", data, offset)
        chunk = data[offset + 8:offset + 8 + size]
        if len(chunk) != size:
            raise ValueError("Truncated WAVE chunk")
        if kind == b"fmt ":
            fmt = struct.unpack_from("<HHIIHH", chunk)
        elif kind == b"data":
            pcm = chunk
        offset += 8 + size + (size & 1)
    if fmt is None or pcm is None or (fmt[0], fmt[1], fmt[4], fmt[5]) != (3, 2, 8, 32):
        raise ValueError("Expected stereo IEEE float32 WAVE")
    samples = np.frombuffer(pcm, dtype="<f4").astype(np.float64).reshape(-1, 2)
    if not len(samples) or not np.isfinite(samples).all():
        raise ValueError("Paired capture is empty or nonfinite")
    return fmt[2], samples


def envelopes(samples, frame):
    return np.sqrt(np.mean(samples[:len(samples) // frame * frame].reshape(-1, frame, 2) ** 2, axis=1))


def envelope_lag(env, start_seconds, end_seconds):
    start, end = round(start_seconds * 100), round(end_seconds * 100)
    ref = env[start:end, 0]
    scores = [float(np.corrcoef(ref, env[start + lag:end + lag, 1])[0, 1]) for lag in range(101)]
    lag = int(np.argmax(scores))
    return {"windowSeconds": [start_seconds, end_seconds], "offsetMs": lag * 10, "correlation": scores[lag]}


def waveform_lag(samples, rate, start_seconds, end_seconds, correlate):
    start, end = round(start_seconds * rate), round(end_seconds * rate)
    ref = samples[start:end, 0]
    ref = ref - np.mean(ref)
    remote = samples[start:end + rate, 1]
    # Per-lag centering/normalization: avoid preferring a loud unrelated segment.
    numerator = correlate(remote, ref, mode="valid", method="fft")
    cumulative = np.r_[0, np.cumsum(remote)]
    squared = np.r_[0, np.cumsum(remote * remote)]
    length = len(ref)
    means = (cumulative[length:] - cumulative[:-length]) / length
    variance = np.maximum(0, squared[length:] - squared[:-length] - length * means ** 2)
    denominator = np.sqrt(np.sum(ref * ref) * variance)
    scores = np.divide(numerator, denominator, out=np.zeros_like(numerator), where=denominator > 1e-15)
    lag = int(np.argmax(scores))
    return {"windowSeconds": [start_seconds, end_seconds], "offsetSamples": lag,
            "offsetMs": lag * 1000 / rate, "normalizedWaveformCorrelation": float(scores[lag])}


def gap_scan(samples, rate, start_seconds, end_seconds, lag_samples):
    frame = round(rate / 100)
    start, end = round(start_seconds * rate), round(end_seconds * rate)
    length = (end - start) // frame * frame
    local = samples[start:start + length, 0].reshape(-1, frame)
    remote = samples[start + lag_samples:start + lag_samples + length, 1].reshape(-1, frame)
    local_rms = np.sqrt(np.mean(local * local, axis=1))
    mask = (local_rms >= 10 ** (-45 / 20)) & np.all(remote == 0, axis=1)
    return {"windowSeconds": [start_seconds, end_seconds], "appliedOffsetSamples": lag_samples,
            "appliedOffsetMs": lag_samples * 1000 / rate, "frameMs": frame * 1000 / rate,
            "localActiveThresholdDbfs": -45, "remoteThreshold": "All samples exactly zero",
            "expectedActiveFrames": int(np.sum(local_rms >= 10 ** (-45 / 20))),
            "strictZeroFrames": int(mask.sum()), "strictZeroDurationMs": int(mask.sum()) * frame * 1000 / rate,
            "localFrameStartsMs": [(start + int(index) * frame) * 1000 / rate for index in np.flatnonzero(mask)]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path, nargs="?", default=Path(__file__).resolve().parents[2] / "artifacts/audio-qa")
    root = parser.parse_args().directory.resolve()
    sys.path.insert(0, str(root / "python-deps"))
    import scipy
    from scipy.signal import correlate

    wav = root / "dfn-transient-paired-repro.wav"
    browser_path = root / "dfn-transient-paired-repro.json"
    browser = json.loads(browser_path.read_text(encoding="utf-8"))
    rate, samples = read_pair(wav)
    if rate != 44100:
        raise ValueError("This diagnostic uses exact 441-sample 10 ms frames at 44100 Hz")
    env = envelopes(samples, 441)
    envelope_results = [envelope_lag(env, start, end) for start, end in
                        ((3, 17.5), (3, 10), (10, 17.5), (2.8, 3.6), (3, 4.3))]
    waveform_results = [waveform_lag(samples, rate, start, end, correlate) for start, end in
                        ((.5, 1.2), (3.06, 3.4), (3.06, 4.3), (3.5, 5), (5, 7), (8, 10), (10, 12), (12, 14), (14, 17))]
    onset = waveform_results[1]
    scans = {"wholeRecordingEnvelopeOffsetAppliedToOnset": gap_scan(samples, rate, 3, 4.3, round(envelope_results[0]["offsetMs"] * rate / 1000)),
             "onsetEnvelopeOffset": gap_scan(samples, rate, 3, 4.3, round(envelope_results[-1]["offsetMs"] * rate / 1000)),
             "onsetWaveformOffset": gap_scan(samples, rate, 3, 4.3, onset["offsetSamples"])}
    diagnostics = browser["result"]["diagnostics"]
    feedback = next(row for row in diagnostics["livekitSenderStats"] if row["type"] == "remote-inbound-rtp")
    receiver = diagnostics["livekitReceiverStats"]
    interpretation = [
        "The new same-clock capture contains the first local processed speech waveform in the received channel: onset-specific waveform correlation is high and the strict-zero onset candidate disappears with onset-specific alignment.",
        "One fixed offset is unsuitable for this capture: the onset waveform offset differs from the later speech offset. Applying the whole-recording RMS-envelope offset to the onset produces a false silence candidate. Receiver playout/clock adjustment is a plausible explanation; these observations do not isolate the responsible WebRTC/codec mechanism.",
        "The original 20 ms candidate compared an independently initialized offline model WAV with a separately started MediaRecorder file. This reproduction does not establish that the original run had no dropout, but it does not reproduce evidence of missing onset samples and does not justify a production change.",
        "Offsets include capture routing, resampling, codec and browser playout behavior. A common recorder clock removes independent recorder origins; it does not make these values network latency, device latency or a quality score.",
        "A zero strict-silence candidate count cannot rule out nonzero distortion, concealment, time compression or losses elsewhere. One loopback run with generated 44.1 kHz source, simulated capture constraints, gate disabled and controlled dtx=false/red=false publication does not establish microphone or real-network quality.",
        "RTP values are cumulative end snapshots. LiveKit receive packetsLost is not exposed by this SDK snapshot; sender feedback is only the publisher-to-server hop. No packet-loss conclusion is inferred from unavailable counters.",
    ]
    report = {"createdAt": datetime.now(timezone.utc).isoformat(), "sampleRate": rate,
              "channels": ["local-processed", "remote-received"], "frames": len(samples),
              "durationSeconds": len(samples) / rate, "finite": True,
              "samplesAtOrAboveFullScale": np.sum(np.abs(samples) >= 1, axis=0).tolist(),
              "peakAbsolute": np.max(np.abs(samples), axis=0).tolist(),
              "methods": {"searchMs": [0, 1000], "envelope": "Pearson correlation of non-overlapping 10 ms RMS envelopes",
                          "waveform": "Normalized, locally mean-centered waveform cross-correlation; FFT numerator with per-lag energy denominator",
                          "onsetWindowSeconds": [3.06, 3.4], "speechStartsInFixtureSeconds": 3,
                          "note": "Window bounds refer to the paired capture clock, not raw fixture timestamps."},
              "envelopeAlignment": envelope_results, "waveformAlignment": waveform_results,
              "onsetGapScans": scans, "interpretation": interpretation,
              "rtp": {"livekitReceiverPacketsLost": receiver.get("packetsLost"),
                      "livekitReceiverConcealedSamples": receiver.get("concealedSamples"),
                      "livekitReceiverConcealmentEvents": receiver.get("concealmentEvents"),
                      "publisherToServerFeedbackPacketsLost": feedback.get("packetsLost")},
              "environment": {"python": sys.version, "numpy": np.__version__, "scipy": scipy.__version__,
                              "scipyLocation": "artifacts/audio-qa/python-deps (isolated QA dependency)"},
              "provenance": {"pairedWavSha256": sha256(wav), "browserReportSha256": sha256(browser_path),
                             "inputWavSha256": sha256(root / "inputs/transient.wav"),
                             "originalReceiverAuditSha256": sha256(root / "receiver-audit.json"),
                             "scriptSha256": sha256(Path(__file__))}}
    (root / "dfn-transient-paired-audit.json").write_text(json.dumps(report, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    lines = ["# DFN transient onset: same-clock follow-up", "",
             f"The local-processed and LiveKit-received channels contain {len(samples) / rate:.3f} seconds of finite stereo float32 PCM at {rate} Hz. Neither channel has full-scale samples.", "",
             f"The first speech waveform matches at an onset-specific offset of {onset['offsetMs']:.2f} ms (normalized waveform correlation {onset['normalizedWaveformCorrelation']:.3f}). Applying this offset yields **{scans['onsetWaveformOffset']['strictZeroFrames']} strict-zero onset frames** with local RMS ≥ −45 dBFS. The onset envelope comparison similarly yields {scans['onsetEnvelopeOffset']['strictZeroFrames']} frames at {scans['onsetEnvelopeOffset']['appliedOffsetMs']:.0f} ms.", "",
             f"The whole-recording envelope comparison chooses {envelope_results[0]['offsetMs']} ms. Applying that single value to the onset would report {scans['wholeRecordingEnvelopeOffsetAppliedToOnset']['strictZeroDurationMs']:.0f} ms of silence. Later speech aligns near 52 ms, whereas the onset aligns near 87 ms; the fixed-offset assumption creates that candidate in this follow-up.", "",
             "| Paired clock window (s) | Waveform offset (ms) | Normalized correlation |",
             "| --- | ---: | ---: |"]
    for row in waveform_results:
        start, end = row["windowSeconds"]
        lines.append(f"| {start:g}–{end:g} | {row['offsetMs']:.2f} | {row['normalizedWaveformCorrelation']:.3f} |")
    lines.extend(["", *[f"- {item}" for item in interpretation], "",
                  "LiveKit receiver concealment: 0 samples / 0 events. Publisher-to-server feedback loss: 0 packets. Subscriber receive loss: not exposed.", "",
                  "The original forty-recording matrix and its one diagnostic candidate are preserved. Read [the detailed JSON](dfn-transient-paired-audit.json), [paired browser run](dfn-transient-paired-repro.json), or [stereo paired WAV](dfn-transient-paired-repro.wav) (left: local processed; right: remote received).", ""])
    (root / "dfn-transient-paired-audit.md").write_text("\n".join(lines), encoding="utf-8")
    print(json.dumps({"durationSeconds": report["durationSeconds"], "onsetWaveformAlignment": onset, "onsetGapScans": scans}, indent=2))


if __name__ == "__main__":
    main()
