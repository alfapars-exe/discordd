# HiChat audio engine assets, protocol v1

All inference runs locally. The application verifies the byte length and SHA-256
in `manifest.json` before creating an engine. Binary downloads are same-origin;
there is no runtime model/CDN request. Engines accept mono 48 kHz PCM.

## Provenance and licenses

The unbundled runtime glue was recovered from the published source maps of
`@sapphi-red/web-noise-suppressor@0.4.1`; its WASM files are copied unchanged.
This avoids rewriting minified worklets or patching installed dependencies.

| Engine | Pinned runtime | License and attribution |
| --- | --- | --- |
| RNNoise | `@shiguredo/rnnoise-wasm@2022.2.0` (the upstream suppressor's patched distribution) | Apache-2.0 glue, `licenses/rnnoise-wasm-LICENSE`; BSD RNNoise, `licenses/rnnoise-COPYING` |
| GTCRN | `@sapphi-red/gtcrn-wasm@0.0.3` | MIT, `licenses/gtcrn-wasm-LICENSE`; GTCRN and PFFFT notices retained verbatim in `vendor/gtcrn.js` |
| Speex | `@sapphi-red/speex-preprocess-wasm@0.4.0` | MIT wrapper; full Xiph/Speex BSD notice retained verbatim in `vendor/speex.js` |
| DeepFilterNet3 | `mezonai/mezon-noise-suppression` commit `f5178ce858aa634b4bf46f27f5684d02828043ae`, `src/df3/df.js` (v1.2.1) | MIT OR Apache-2.0, included `LICENSE-MIT` and `LICENSE-APACHE` |

DeepFilter reuses the existing `../../deepfilter/v2/pkg/df_bg.wasm`. Its existing
compressed model archive is copied byte-for-byte to `deepfilter-model.bin`;
the `.bin` name prevents static servers from serving `.tar.gz` with
`Content-Encoding:gzip` and browsers transparently decompressing the model before
inference. Both exact hashes are pinned. `vendor/deepfilter-upstream.js` preserves the original generated glue.
`vendor/deepfilter.js` wraps that same source in a factory to isolate each model's
WASM instance. The v1.3.0 npm package's generated glue is incompatible with this
WASM ABI and must not be substituted independently. The immutable v1.2.1
`src/asset-loader/AssetLoader.ts` selects official CDN generation `deepfilternet3/v2`.
Both bundled binaries match those official v2 CDN responses byte-for-byte
(verified 2026-10-23). The model also matches the immutable
`Rikorose/DeepFilterNet` commit `84d57ec2c08fe08e68a13fb32a58cd7092060a0f`.
The manifest pins the binding, wrapper, model and WASM hashes together. The WASM
CDN URL is generation-versioned but lacks an immutable upstream build attestation;
the exact bundled bytes and real inference tests are the compatibility guarantee.
Download evidence is in `artifacts/audio-qa/deepfilter-provenance-downloads.json`
at the repository root. v1.3.0's loader selects generation v3, whose binary differs.

RNNoise glue has two documented environment adjustments matching the upstream
worklet build: treat AudioWorklet as a web realm and omit the window/importScripts
guard. Audio assets are supplied as verified bytes. No network-loader branch runs.

## Ownership and readiness

`engine-worklet.js` owns RNNoise/GTCRN/Speex inference and acknowledges `READY` only after
model creation and a real inference warm-up. Init/runtime errors emit `ERROR`
and terminate; they never silently substitute raw audio. The application chooses
and displays fallback. `CONFIG` changes DFN attenuation. `DESTROY` frees RNNoise,
GTCRN and Speex state/buffers and returns `DESTROYED` before terminating the node.

The pinned DeepFilter binary does not export a deallocator for the raw pointer
returned by `df_create`. Its `__wbg_dfstate_free` belongs to a different
wasm-bindgen wrapper and **must not be called with that raw pointer**. Each DFN
engine therefore owns a dedicated module worker and private runtime. It reports
`READY` only after real inference warm-up; its AudioWorklet performs only PCM
transport. Disposal terminates the worker, releases the entire private heap and
closes/disconnects the bridge. No model-state sharing is used. In-flight input is
bounded to ten frames (100 ms); output is capped at twenty frames (200 ms).
Stalled inference fails closed instead of accumulating unbounded audio delay.

Every worklet emits a processing heartbeat even during silence. The host starts
its watchdog only after a connected graph renders; six seconds of advancing
audio time without another heartbeat triggers the visible fallback. Suspended
contexts and disconnected initialization candidates do not trigger this check.

GTCRN's 48 kHz interface internally downsamples its model to 16 kHz and resamples
the output. Frequencies above 8 kHz are not recovered. RNNoise/DFN3 stay at 48 kHz.
The fixed frame queue adds 10 ms for RNNoise/Speex and 16 ms for GTCRN; DFN's worker
bridge starts with 20 ms of PCM buffering, before
the model's own algorithmic delay and any downstream gate lookahead.

## Verification

From `client/` run:

```sh
node --experimental-vm-modules --test scripts/audio-engines.verify.mjs
npm test -- src/audio/engines/workletEngine.test.ts
```

The first command executes the real bundled WASM and DFN model, verifies hashes,
tests noise attenuation, frame continuity, readiness, invalid-rate/model failures
and repeated initialization/disposal. The second exercises host lifecycle races,
startup timeout, retry after failed asset downloads and cancellation. These do not
replace listening tests with quiet speech, keyboard transients and real devices.

### Isolated browser and real transport acceptance

The optional browser runners use an isolated, headless Chromium profile and never
request microphone permission. Install Playwright in a development environment
(or point `HICHAT_PLAYWRIGHT_MODULE` at its `index.mjs`), then start the client Vite
server and a local LiveKit development server:

```sh
# Separate terminals; LiveKit's development key/secret are local test credentials.
npm run dev -- --host 127.0.0.1 --port 3041
livekit-server --dev --bind 127.0.0.1 --node-ip 127.0.0.1 --port 17880
```

Run from `client/`, with environment variables appropriate to your shell:

```sh
HICHAT_AUDIO_QA_URL=http://127.0.0.1:3041 HICHAT_AUDIO_SOAK_MS=180000 HICHAT_AUDIO_FIXTURES=1 node scripts/audio-browser.verify.mjs
# Or run the four-input, five-engine recording matrix independently:
node scripts/audio-fixtures.verify.mjs
# Short focused checks:
node scripts/audio-gate-browser.verify.mjs
node scripts/audio-transport.verify.mjs
node scripts/audio-fallback-browser.verify.mjs
node scripts/audio-listening.verify.mjs
# Optional bounded diagnostic of the DFN transient onset:
node scripts/audio-pair.verify.mjs
```

`HICHAT_CHROME_PATH` optionally selects an installed Chrome executable; otherwise
Playwright uses its installed Chromium. These scripts do not use a user profile.
The transport probe permits only the loopback LiveKit endpoint and signs ephemeral
local development tokens. Real RTP and both receiver PCM streams are measured.
The six-mode transport smoke uses `micPublishFor('konusma')` (DTX and RED enabled,
mono requested). The four-fixture recording matrix keeps DTX and RED disabled
for controlled model comparison; its codec settings differ from that production
smoke and are explicitly recorded. P2P uses the direct browser RTP defaults.
Generated input tracks cannot implement hardware capture constraints, so only
their capture-policy setters/getters are simulated and explicitly marked in JSON.
This does not measure the browser's built-in noise suppression, AEC or AGC.

The fixture runs require `artifacts/audio-qa/inputs/{clean,fan,keyboard,transient}.wav`
at the repository root. Only these input requests are served through a scoped
Playwright route, using the exact local bytes and recording their SHA-256 hashes;
model/WASM and LiveKit requests use the real servers. Inputs are generated by the
offline comparison scripts with source/license attribution in `report.json`.
Reports and receiver WebM recordings are written to `artifacts/audio-qa/`.
The browser runner also checks the listening page metadata and saves a screenshot.
The focused listening runner checks all four fixtures and all three recording
sources (offline, LiveKit and P2P). The fallback runner deliberately supplies a
corrupt model asset and simulates unsupported AudioWorklet/native-constraint
capabilities while measuring continuity through the real native audio graph.
The paired diagnostic records the same LiveKit pipeline output and its received
audio as two lossless channels on one audio clock; it writes separate repro files
without overwriting the comparison matrix.
The three-minute DFN run and twenty create/dispose cycles are bounded smoke tests,
not evidence of hours-long, mobile or physical-microphone reliability.
