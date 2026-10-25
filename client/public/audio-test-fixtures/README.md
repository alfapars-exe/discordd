# Turkish speech QA fixture

`turkish-fleurs-original.wav` is an unmodified, real recorded Turkish speech
sample from [Google FLEURS](https://huggingface.co/datasets/google/fleurs), test
split `tr_tr`, sample `10000377651956138413.wav` (id 2004). The original is mono
16 kHz float32 WAV, 14.16 seconds. It is not a recording of a HiChat user.

Licensed under [Creative Commons Attribution 4.0 International
(CC BY 4.0)](https://creativecommons.org/licenses/by/4.0/). Attribution:
FLEURS (2022), Alexis Conneau, Min Ma, Simran Khanuja, Yu Zhang, Vera Axelrod,
Siddharth Dalmia, Jason Riesa, Clara Rivera, Ankur Bapna, Google and dataset
contributors. [Paper](https://arxiv.org/abs/2205.12446).

See `provenance.json` for the exact upstream commit, source archive/member,
SHA-256, original transcription and download size. The official dataset card
declares `cc-by-4.0`. Only the first 747,520 compressed bytes of the archive were
read to extract this sample; the full archive was not downloaded.

From the client directory, run:

```sh
node --experimental-vm-modules scripts/audio-compare.mjs
```

This generates deterministic 48 kHz clean/fan/keyboard/transient fixtures and
engine outputs under `../artifacts/audio-qa/`, with the same attribution.
Set the `FFMPEG_PATH` environment variable to an installed FFmpeg executable to
include DTLN in the same report. Its separate classic Worker/TFLite harness uses
64-tap anti-alias filtering for 48-to-16-to-48 kHz conversion. The command bounds
each engine subprocess to 60 seconds. WebRTC microphone DSP requires browser
capture testing and is not measured here.
DeepFilterNet3 uses the app default strength of 70%; the shared application
mapping yields a 10 dB attenuation limit. The exact parameters are recorded in
the report. To refresh just that engine while preserving other measurements,
run `node --experimental-vm-modules scripts/audio-compare.mjs ../artifacts/audio-qa --refresh deepfilter`.
Changes are 16-to-48 kHz interpolation, level normalization, three seconds of
leading silence and two seconds of trailing silence, and generated noise in
the three mixtures. The downloaded original remains unchanged.

Resampling cannot restore speech above 8 kHz. These recordings cannot establish
full-band quality, subjective preference, target-speaker isolation or browser
end-to-end latency. Synthetic noise is not a substitute for a diverse recorded
noise and speech benchmark. The energy gate is excluded from these engine-only
measurements.
