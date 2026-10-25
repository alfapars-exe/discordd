# STOI / ESTOI — Turkish speech fixture

Reference-based objective proxies; this is not a human listening test or a quality pass/fail verdict.

Method: [pystoi 0.4.1](https://pypi.org/project/pystoi/0.4.1/) ([official implementation](https://github.com/mpariente/pystoi)), with [SciPy 1.15.3](https://pypi.org/project/scipy/1.15.3/).

- One speaker reading one Turkish sentence, originally 16 kHz, with synthetic noises. Scores do not establish performance across speakers, languages, microphones or real environments.
- STOI and ESTOI are reference-based objective intelligibility proxies, not word-recognition percentages, listening tests, overall sound quality or a release pass/fail criterion. Higher scores are not proof of universal superiority.
- Only the original 14.16-second speech region is scored. The three-second leading and two-second trailing noise-only padding are excluded; pystoi additionally removes silent frames using the clean reference.
- Alignment uses each output's existing waveform-correlation lag from report.json, rounded to the nearest sample. No per-metric lag search, amplitude normalization or favorable segment selection is applied.
- pystoi internally resamples to 10 kHz and evaluates speech-band envelopes; these metrics cannot establish preservation of frequencies above 8 kHz or justify the 16 kHz modes' full-band fidelity.
- All inputs and model outputs are saved PCM16 WAVs. These are model-only offline outputs, without the energy gate, microphone processing, browser queues or LiveKit/P2P encoding. Quantization may influence quiet frames.
- All 20 engine/fixture combinations and unprocessed input baselines are reported, including degradation. Negative deltas are preserved; no score threshold is used to declare success.

## Unprocessed input baselines

| Fixture | STOI | ESTOI |
| --- | ---: | ---: |
| clean | 1.0000 | 1.0000 |
| fan | 0.7158 | 0.5237 |
| keyboard | 0.7671 | 0.7709 |
| transient | 0.9995 | 0.9968 |

## Every engine output

Deltas are against the matching unprocessed fixture. No ranking or success threshold is applied.

| Engine | Fixture | Lag (ms) | STOI | ESTOI | Δ STOI | Δ ESTOI |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| rnnoise | clean | 10.000 | 0.9945 | 0.9788 | -0.0055 | -0.0212 |
| rnnoise | fan | 10.000 | 0.8110 | 0.5824 | +0.0952 | +0.0587 |
| rnnoise | keyboard | 9.979 | 0.8499 | 0.8172 | +0.0828 | +0.0462 |
| rnnoise | transient | 10.000 | 0.9927 | 0.9727 | -0.0068 | -0.0241 |
| gtcrn | clean | 18.542 | 0.9872 | 0.9714 | -0.0128 | -0.0286 |
| gtcrn | fan | 18.542 | 0.8274 | 0.6233 | +0.1116 | +0.0996 |
| gtcrn | keyboard | 18.542 | 0.9510 | 0.9024 | +0.1838 | +0.1315 |
| gtcrn | transient | 18.542 | 0.9871 | 0.9665 | -0.0124 | -0.0304 |
| speex | clean | 10.000 | 0.9969 | 0.9872 | -0.0031 | -0.0128 |
| speex | fan | 10.000 | 0.7658 | 0.5885 | +0.0499 | +0.0648 |
| speex | keyboard | 10.000 | 0.7679 | 0.7653 | +0.0008 | -0.0056 |
| speex | transient | 9.979 | 0.9956 | 0.9812 | -0.0039 | -0.0157 |
| deepfilter | clean | 30.000 | 0.9912 | 0.9882 | -0.0088 | -0.0118 |
| deepfilter | fan | 30.000 | 0.8178 | 0.6253 | +0.1019 | +0.1016 |
| deepfilter | keyboard | 30.000 | 0.8652 | 0.8313 | +0.0981 | +0.0604 |
| deepfilter | transient | 30.000 | 0.9925 | 0.9863 | -0.0070 | -0.0105 |
| dtln | clean | 24.000 | 0.9962 | 0.9835 | -0.0038 | -0.0165 |
| dtln | fan | 24.000 | 0.8447 | 0.6566 | +0.1288 | +0.1328 |
| dtln | keyboard | 24.000 | 0.9506 | 0.9110 | +0.1835 | +0.1401 |
| dtln | transient | 24.000 | 0.9963 | 0.9859 | -0.0032 | -0.0109 |

Every comparison uses the same complete 14.16-second reference segment after the saved latency alignment. Clean/clean identity was checked against 1.0 for both metrics. Fixed RNG seed makes pystoi's tiny ESTOI normalization perturbations repeatable.

See [intelligibility.json](intelligibility.json) for exact values, warnings, source provenance, SHA-256 hashes of all 24 WAV files and the alignment report, package wheel URLs/hashes, implementation hashes and runtime versions. Existing WAV files are not modified.
