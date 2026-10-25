# DFN transient onset: same-clock follow-up

The local-processed and LiveKit-received channels contain 20.628 seconds of finite stereo float32 PCM at 44100 Hz. Neither channel has full-scale samples.

The first speech waveform matches at an onset-specific offset of 86.83 ms (normalized waveform correlation 0.946). Applying this offset yields **0 strict-zero onset frames** with local RMS ≥ −45 dBFS. The onset envelope comparison similarly yields 0 frames at 90 ms.

The whole-recording envelope comparison chooses 50 ms. Applying that single value to the onset would report 30 ms of silence. Later speech aligns near 52 ms, whereas the onset aligns near 87 ms; the fixed-offset assumption creates that candidate in this follow-up.

| Paired clock window (s) | Waveform offset (ms) | Normalized correlation |
| --- | ---: | ---: |
| 0.5–1.2 | 241.72 | 0.631 |
| 3.06–3.4 | 86.83 | 0.946 |
| 3.06–4.3 | 86.83 | 0.945 |
| 3.5–5 | 52.04 | 0.826 |
| 5–7 | 52.02 | 0.985 |
| 8–10 | 51.97 | 0.958 |
| 10–12 | 51.97 | 0.976 |
| 12–14 | 52.00 | 0.998 |
| 14–17 | 52.04 | 0.932 |

- The new same-clock capture contains the first local processed speech waveform in the received channel: onset-specific waveform correlation is high and the strict-zero onset candidate disappears with onset-specific alignment.
- One fixed offset is unsuitable for this capture: the onset waveform offset differs from the later speech offset. Applying the whole-recording RMS-envelope offset to the onset produces a false silence candidate. Receiver playout/clock adjustment is a plausible explanation; these observations do not isolate the responsible WebRTC/codec mechanism.
- The original 20 ms candidate compared an independently initialized offline model WAV with a separately started MediaRecorder file. This reproduction does not establish that the original run had no dropout, but it does not reproduce evidence of missing onset samples and does not justify a production change.
- Offsets include capture routing, resampling, codec and browser playout behavior. A common recorder clock removes independent recorder origins; it does not make these values network latency, device latency or a quality score.
- A zero strict-silence candidate count cannot rule out nonzero distortion, concealment, time compression or losses elsewhere. One loopback run with generated 44.1 kHz source, simulated capture constraints, gate disabled and controlled dtx=false/red=false publication does not establish microphone or real-network quality.
- RTP values are cumulative end snapshots. LiveKit receive packetsLost is not exposed by this SDK snapshot; sender feedback is only the publisher-to-server hop. No packet-loss conclusion is inferred from unavailable counters.

LiveKit receiver concealment: 0 samples / 0 events. Publisher-to-server feedback loss: 0 packets. Subscriber receive loss: not exposed.

The original forty-recording matrix and its one diagnostic candidate are preserved. Read [the detailed JSON](dfn-transient-paired-audit.json), [paired browser run](dfn-transient-paired-repro.json), or [stereo paired WAV](dfn-transient-paired-repro.wav) (left: local processed; right: remote received).
