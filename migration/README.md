# Rust + Flutter migration — Windows/web proof

This isolated branch implements a functional proof client against the existing Go
server. It is not the complete HiChat replacement and has not been published.
Reference source: `8f443aac23649e8468a320850498e823826a0c5f`; shared checkout
changes are excluded, and this reference is not asserted to be the deployed release.

## Implemented

- HTTPS/loopback origin validation, Go login and MFA, CSRF client hint, cookie-only
  refresh and logout; access tokens in memory, single-flight refresh and late-result
  fencing. Native refresh cookies stay in an origin-bound memory jar; browser
  cookies remain HttpOnly. Credentials are never written to localStorage.
- Rust reads existing AES-GCM/PBKDF2 recovery backups (legacy 1M, current 2M,
  allowed legacy range), validates account ownership and exposes only cached
  historical messages. Original encrypted archives can be downloaded/pasted and
  retained separately by origin/account. Passwords and decrypted device keys are
  not persisted. This does not activate an old device identity/ratchet or decrypt
  ciphertext absent from the backup's message cache.
- Grouped channel discovery; ticket-authenticated WS presence; encrypted LiveKit
  room admission, microphone, camera, screen publishing, track rendering and device
  selection. Media uses authoritative key indices, closes on rekey/moderation or
  auth invalidation, and releases owned tracks and key provider on leave.
- Windows screen/window picker. Browser capture uses the browser chooser; mobile
  browser capture is subject to browser support. See the incremental media slice
  below for native audio, direct calls and the HUD. Seamless rekey/reconnect,
  DSP parity and background mobile calling remain open.

## Build and test

Use Flutter 3.47.9, bridge/codegen 2.13.0 and locked Dart/Cargo dependencies.
Rust/native hook toolchain is pinned in `hichat_native_proof/rust/rust-toolchain.toml`.
Put Flutter and Cargo binaries on PATH. Install `wasm-pack` and nightly `rust-src`
for the bridge's shared-memory WASM build.

```powershell
node migration/scripts/baseline.mjs --check
cargo test --manifest-path migration/Cargo.toml --workspace --release --locked
cargo clippy --manifest-path migration/Cargo.toml --workspace --locked -- -D warnings
cd migration/hichat_native_proof
flutter pub get
# Only if Windows symlink support prevents pub get:
../scripts/prepare-windows-plugins.ps1
flutter pub get
flutter analyze --no-pub
flutter test --no-pub test
flutter build windows --release --no-pub
../scripts/build-web.ps1
```

`build-web.ps1` compiles the SDK E2EE worker and Rust WASM before Flutter. It
checks the original dart_webrtc 1.8.2 source SHA-256, applies the documented
256-slot bounds correction to a local copy, and bundles its MIT notice. It never
patches the shared Pub cache. See `third_party/dart-webrtc-keyring.patch`.
A web deployment must serve COOP `same-origin`, COEP `require-corp`, WASM with the
correct MIME type, the Rust pkg files and `e2ee.worker.dart.js`. Current builds use
Flutter's JavaScript renderer plus Rust WASM; Flutter's optional all-Dart WASM
renderer has an upstream bridge dry-run compatibility warning.

## Local end-to-end fixtures

The QA scripts are hardcoded to a disposable API at `127.0.0.1:19090`. Never point
them at production. Synthetic credentials and receipts stay under ignored `.local`.
`prepare-local-qa.mjs` creates a test account/server and WebCrypto-encrypted backup;
`prepare-media-peer.mjs` adds a second test user. The loopback-only `proof-server.mjs`
serves `build/web` at port 18080 and proxies only to that disposable API.
`browser-qa.cjs` checks desktop plus Android/iPhone user-agent emulation in Chromium.
`media-browser-qa.cjs` publishes fake camera/audio and, with `HICHAT_TEST_SCREEN=1`,
a synthetic tab (not the user's desktop). Run the Windows receiver integration
while that peer is ready. Tests require an installed Playwright package via NODE_PATH.

```powershell
flutter test --no-pub integration_test/windows_flow_test.dart -d windows --dart-define=HICHAT_QA_FILE=ABSOLUTE_PATH_TO_LOCAL_QA_JSON
flutter test --no-pub integration_test/media_peer_test.dart -d windows --dart-define=HICHAT_QA_FILE=ABSOLUTE_PATH_TO_LOCAL_QA_JSON
```

See `VERIFICATION.md` and `DEVICE_ACCEPTANCE.md` for evidence and open gates.
Production services and update feeds are unchanged. Explicit handoff now upgrades
only the selected source account store to a retirement schema; see HANDOFF.md.
No automatic identity takeover or old-ratchet downgrade is allowed. A backend
cutover still requires one active Hub/writer/scheduler.

## Incremental Windows media slice

The Flutter call tab now implements accepted direct microphone/camera calls against
the existing Go WS contract. Windows also has an opt-in native loopback audio path
and a Rust HUD for a selected external game's foreground window. These additions
are locally exercised proof features, not complete product parity. See the dated
2026-10-31 entries in VERIFICATION.md and DEVICE_ACCEPTANCE.md, and HANDOFF.md for
the protected persistent live encryption-device transfer and remaining gates.

## Rust message kernels — 2026-10-31

The client core now contains pure X3DH, Double Ratchet and signed Sender Key
transitions, checked against the current TypeScript implementation. See
CRYPTO_VERIFICATION.md for the 25 synthetic reference cases, error paths and
explicit integration limits. DeviceVault commits peer preparation under exclusive
ownership after source retirement; see HANDOFF.md. Complete chat dispatch and
receive orchestration remain additional work.
