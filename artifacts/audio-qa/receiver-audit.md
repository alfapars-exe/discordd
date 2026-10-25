# Receiver recording audit

Audited 40 / 40 expected receiver recordings. Complete matrix: True.

- These are local loopback LiveKit and direct-P2P receiver recordings from one Turkish sentence and synthetic noises. Capture constraints are simulated on generated tracks; no microphone, browser capture DSP effectiveness or real-world network quality is established.
- FFmpeg decodes the first audio stream to mono float32 at 48 kHz; stereo recordings are downmixed. Finite samples, duration and full-scale counts are file-integrity observations, not subjective quality verdicts. Opus decoding can produce overshoots; counts are reported without clipping or normalization.
- Recording duration follows actual MediaRecorder/audio time. The probe's requested duration uses host timers, so scheduling and recorder start/stop differences can make the file longer. These durations are not round-trip or device latency.
- Alignment is a bounded 0..1000 ms, 10 ms-resolution RMS-envelope comparison against the matching offline engine output. Whole, early and late speech windows are reported. Browser resampling, worker buffering, Opus, playout, MediaRecorder origins and clock drift can change alignment.
- Gap scanning is omitted when the explicit alignment heuristic is uncertain. Otherwise a candidate requires reference RMS >= -45 dBFS and receiver RMS exactly zero for a 10 ms frame. This diagnostic does not detect every dropout or distinguish codec concealment, model changes and packet loss; zero candidates is not proof of gap-free speech.
- RTP counters are cumulative end snapshots, including setup before the recording. Missing SDK counters remain null. Concealment can occur with zero reported packet loss because of timing/playout behavior. Muted renderer audio-energy counters can remain zero despite nonzero decoded PCM.
- No listening-quality score or aggregate quality pass/fail is computed. Original WAV and WebM files are read only. Existing STOI/ESTOI results refer to offline model outputs, not these encoded transport recordings.

| Engine | Fixture | Transport | Duration (s) | Finite | Full-scale samples | Recording offset (ms) / envelope r | Strict-zero candidates | Receiver lost / concealed samples |
| --- | --- | --- | ---: | --- | ---: | --- | --- | --- |
| rnnoise | clean | livekit | 22.560 | True | 0 | 90 / 0.963 | 0 | not exposed / 0 |
| rnnoise | clean | p2p | 22.560 | True | 0 | 100 / 0.968 | 0 | 0 / 2076 |
| rnnoise | fan | livekit | 19.800 | True | 0 | 90 / 0.995 | 0 | not exposed / 0 |
| rnnoise | fan | p2p | 19.800 | True | 0 | 90 / 0.973 | 0 | 0 / 2076 |
| rnnoise | keyboard | livekit | 19.740 | True | 0 | 90 / 0.938 | 0 | not exposed / 0 |
| rnnoise | keyboard | p2p | 19.740 | True | 0 | 100 / 0.975 | 0 | 0 / 2076 |
| rnnoise | transient | livekit | 19.800 | True | 0 | 90 / 0.970 | 0 | not exposed / 0 |
| rnnoise | transient | p2p | 19.800 | True | 0 | 100 / 0.973 | 0 | 0 / 2076 |
| gtcrn | clean | livekit | 22.860 | True | 0 | 110 / 0.972 | 0 | not exposed / 0 |
| gtcrn | clean | p2p | 22.860 | True | 0 | 100 / 0.966 | 0 | 0 / 0 |
| gtcrn | fan | livekit | 20.100 | True | 0 | 100 / 0.975 | 0 | not exposed / 0 |
| gtcrn | fan | p2p | 20.100 | True | 0 | 100 / 0.969 | 0 | 0 / 2076 |
| gtcrn | keyboard | livekit | 19.740 | True | 0 | 100 / 0.983 | 0 | not exposed / 0 |
| gtcrn | keyboard | p2p | 19.740 | True | 0 | 110 / 0.983 | 0 | 0 / 2076 |
| gtcrn | transient | livekit | 20.640 | True | 0 | 100 / 0.977 | 0 | not exposed / 0 |
| gtcrn | transient | p2p | 20.640 | True | 0 | 100 / 0.990 | 0 | 0 / 0 |
| speex | clean | livekit | 22.920 | True | 0 | 90 / 0.799 | not assessed (alignment) | not exposed / 0 |
| speex | clean | p2p | 22.980 | True | 0 | 90 / 0.787 | not assessed (alignment) | 0 / 0 |
| speex | fan | livekit | 19.740 | True | 0 | 90 / 0.774 | not assessed (alignment) | not exposed / 0 |
| speex | fan | p2p | 19.740 | True | 0 | 90 / 0.781 | not assessed (alignment) | 0 / 2076 |
| speex | keyboard | livekit | 19.740 | True | 0 | 110 / 0.780 | not assessed (alignment) | not exposed / 0 |
| speex | keyboard | p2p | 19.740 | True | 0 | 100 / 0.901 | not assessed (alignment) | 0 / 0 |
| speex | transient | livekit | 22.680 | True | 0 | 100 / 0.824 | not assessed (alignment) | not exposed / 0 |
| speex | transient | p2p | 22.680 | True | 0 | 100 / 0.818 | not assessed (alignment) | 0 / 2076 |
| deepfilter | clean | livekit | 22.620 | True | 0 | 100 / 0.928 | 0 | not exposed / 0 |
| deepfilter | clean | p2p | 22.620 | True | 0 | 100 / 0.933 | 0 | 0 / 0 |
| deepfilter | fan | livekit | 19.740 | True | 0 | 90 / 0.888 | not assessed (alignment) | not exposed / 0 |
| deepfilter | fan | p2p | 19.740 | True | 0 | 100 / 0.875 | not assessed (alignment) | 0 / 0 |
| deepfilter | keyboard | livekit | 20.460 | True | 0 | 100 / 0.958 | 0 | not exposed / 0 |
| deepfilter | keyboard | p2p | 20.460 | True | 0 | 100 / 0.909 | 0 | 0 / 0 |
| deepfilter | transient | livekit | 22.560 | True | 0 | 110 / 0.943 | 1 | not exposed / 0 |
| deepfilter | transient | p2p | 22.560 | True | 0 | 110 / 0.952 | 0 | 0 / 0 |
| dtln | clean | livekit | 22.020 | True | 0 | 160 / 0.939 | 0 | not exposed / 0 |
| dtln | clean | p2p | 22.020 | True | 0 | 150 / 0.971 | 0 | 0 / 0 |
| dtln | fan | livekit | 19.740 | True | 0 | 160 / 0.756 | not assessed (alignment) | not exposed / 0 |
| dtln | fan | p2p | 19.740 | True | 0 | 140 / 0.765 | not assessed (alignment) | 0 / 0 |
| dtln | keyboard | livekit | 19.800 | True | 0 | 170 / 0.957 | 0 | not exposed / 0 |
| dtln | keyboard | p2p | 19.800 | True | 0 | 140 / 0.960 | 0 | 0 / 0 |
| dtln | transient | livekit | 21.600 | True | 0 | 160 / 0.975 | 0 | not exposed / 0 |
| dtln | transient | p2p | 21.600 | True | 0 | 160 / 0.967 | 0 | 0 / 0 |

See [receiver-audit.json](receiver-audit.json) for exact PCM counts, source codecs/channels, file hashes, alignment reliability checks, each gap candidate, cumulative RTP feedback/concealment counters, actual source clocks and provenance.
