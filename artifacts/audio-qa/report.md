# Offline Turkish audio comparison

[FLEURS](https://huggingface.co/datasets/google/fleurs) sample 10000377651956138413.wav, by FLEURS (2022), Alexis Conneau, Min Ma, Simran Khanuja, Yu Zhang, Vera Axelrod, Siddharth Dalmia, Jason Riesa, Clara Rivera, and Ankur Bapna; Google and dataset contributors. Licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Derived fixtures resample, normalize, pad and add synthetic noise; engine outputs apply denoising.

DeepFilterNet3 uses the app default UI strength 70%, mapped by the shared app helper to a 10 dB attenuation limit.

- One read Turkish sentence, originally 16 kHz: cannot evaluate full-band speech above 8 kHz or represent all speakers.
- Synthetic noise is controlled and repeatable; no subjective quality verdict or target-speaker isolation is measured.
- Engine-only synchronous DSP: excludes FrameQueue, AudioWorklet/Worker queues, resampling transport, energy gate, LiveKit, device and browser latency.
- Process CPU time has coarse OS accounting and can be zero per frame; inference wall-time percentiles are useful CPU-budget proxies, not end-to-end latency.
- Output lag is waveform cross-correlation against clean speech over a bounded 0-250 ms search, not an acoustic latency measurement.
- DTLN uses its real TFLite Worker VM with offline 64-tap anti-alias 48-to-16-to-48 kHz resampling. Inference times exclude resampling, and attenuation includes its bandwidth restriction.
- WebRTC capture noise suppression is unmeasured: this offline harness does not emulate browser microphone DSP.

| Engine / output WAV | Fixture / input WAV | Inference p50 / p95 / p99 (ms) | Lag (ms) | Correlation | Noise attenuation lead / tail (dB) |
| --- | --- | --- | --- | --- | --- |
| [rnnoise](rnnoise-clean.wav) | [clean](inputs/clean.wav) | 0.134 / 0.206 / 0.270 | 10.00 | 0.802 | n/a |
| [rnnoise](rnnoise-fan.wav) | [fan](inputs/fan.wav) | 0.139 / 0.214 / 0.284 | 10.00 | 0.711 | 49.4 / 50.7 |
| [rnnoise](rnnoise-keyboard.wav) | [keyboard](inputs/keyboard.wav) | 0.123 / 0.167 / 0.235 | 9.98 | 0.759 | 3.9 / 15.3 |
| [rnnoise](rnnoise-transient.wav) | [transient](inputs/transient.wav) | 0.126 / 0.172 / 0.253 | 10.00 | 0.795 | 12.7 / 4.9 |
| [gtcrn](gtcrn-clean.wav) | [clean](inputs/clean.wav) | 0.738 / 2.083 / 3.626 | 18.54 | 0.871 | n/a |
| [gtcrn](gtcrn-fan.wav) | [fan](inputs/fan.wav) | 0.713 / 1.766 / 2.471 | 18.54 | 0.774 | 30.4 / 31.4 |
| [gtcrn](gtcrn-keyboard.wav) | [keyboard](inputs/keyboard.wav) | 0.722 / 1.642 / 2.074 | 18.54 | 0.834 | 56.7 / 41.0 |
| [gtcrn](gtcrn-transient.wav) | [transient](inputs/transient.wav) | 0.737 / 1.792 / 2.263 | 18.54 | 0.842 | 56.4 / 48.8 |
| [speex](speex-clean.wav) | [clean](inputs/clean.wav) | 0.037 / 0.071 / 0.097 | 10.00 | 1.000 | n/a |
| [speex](speex-fan.wav) | [fan](inputs/fan.wav) | 0.042 / 0.074 / 0.120 | 10.00 | 0.891 | 10.3 / 9.9 |
| [speex](speex-keyboard.wav) | [keyboard](inputs/keyboard.wav) | 0.033 / 0.072 / 0.114 | 10.00 | 0.750 | 0.3 / 0.3 |
| [speex](speex-transient.wav) | [transient](inputs/transient.wav) | 0.031 / 0.056 / 0.074 | 9.98 | 0.920 | 0.3 / 0.2 |
| [deepfilter](deepfilter-clean.wav) | [clean](inputs/clean.wav) | 1.152 / 1.522 / 1.739 | 30.00 | 0.924 | n/a |
| [deepfilter](deepfilter-fan.wav) | [fan](inputs/fan.wav) | 1.306 / 1.617 / 2.099 | 30.00 | 0.842 | 10.0 / 10.0 |
| [deepfilter](deepfilter-keyboard.wav) | [keyboard](inputs/keyboard.wav) | 0.769 / 2.000 / 2.308 | 30.00 | 0.851 | 10.0 / 10.0 |
| [deepfilter](deepfilter-transient.wav) | [transient](inputs/transient.wav) | 0.870 / 2.179 / 2.326 | 30.00 | 0.908 | 10.0 / 10.0 |
| [dtln](dtln-clean.wav) | [clean](inputs/clean.wav) | 0.487 / 0.584 / 0.729 | 24.00 | 0.916 | n/a |
| [dtln](dtln-fan.wav) | [fan](inputs/fan.wav) | 0.705 / 0.939 / 1.033 | 24.00 | 0.947 | 25.8 / 26.3 |
| [dtln](dtln-keyboard.wav) | [keyboard](inputs/keyboard.wav) | 0.687 / 0.931 / 1.018 | 24.00 | 0.899 | 36.8 / 38.4 |
| [dtln](dtln-transient.wav) | [transient](inputs/transient.wav) | 0.683 / 0.933 / 1.006 | 24.00 | 0.873 | 34.7 / 30.7 |

See report.json for immutable recording provenance, machine details, CPU accounting, initialization cost and measurement definitions. Input and output WAV files are PCM16 mono 48 kHz; inference uses the exact saved PCM16 input samples, and output measurements precede PCM16 output quantization.
