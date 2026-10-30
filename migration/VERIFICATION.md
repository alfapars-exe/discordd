# Windows/web verification — 2026-10-30

This is a local proof receipt, not a completed rewrite, hosted CI, release,
installer upgrade or physical-device acceptance.

## Verified

- Source reference: 338 routes and six compatibility source hashes still match.
- Seven Rust tests, including independent WebCrypto fixtures for legacy 1M and
  current 2M PBKDF2 backups, wrong password/owner, malformed input and KDF bounds.
- Rust Clippy with warnings denied and portable WASM core compilation.
- Ten Flutter API/widget tests: Go cookie-only session contract, MFA, refresh
  single-flight, late-response fencing, media token ownership/version and
  320/390/1280-pixel login layouts. Analyzer clean.
- Windows local Go login -> recovery archive decrypted by Rust -> encrypted
  LiveKit room join -> logout passes against an isolated SQLite database.
- Desktop, Android-UA and iPhone-UA Chromium contexts perform real local login,
  WebCrypto-to-Rust history recovery and logout clearing. These are emulated
  contexts, not real Android Chrome, Safari or iOS devices.
- Chrome fake camera/microphone plus a synthetic tab publisher connects to the
  isolated LiveKit v1.9.12 server. Windows receives and decodes 13 camera frames
  and 13 screen-share frames in the encrypted room. No physical microphone,
  camera, or user's desktop was captured for this test.
- Windows release and web builds are produced locally. The web includes compiled
  Rust WASM and the SDK E2EE worker with the hash-checked 256-slot correction.

Sanitized machine-readable results and artifact/source hashes are in
`evidence/windows-web.json`. Synthetic accounts, credentials, DB, screenshots and
raw local receipts stay in ignored `.local`; no production credentials were used.

## Tooling and observed limits

Installed wasm-pack, cargo-expand (bridge generation), nightly rust-src and SDK
build dependencies. Project-local junctions let Flutter register Windows plugins
without changing Windows developer mode. Merely building without successful
plugin registration had previously produced MissingPluginException; the actual
native integration now runs the registered WebRTC plugin.

Flutter's optional Dart-WASM renderer dry run warns about an upstream bridge
interop check. The verified web artifact uses compiled Dart JavaScript plus Rust
WASM. Native SDK teardown emits data-channel-close warnings despite passing tests;
long repeated-call/resource acceptance remains open and this receipt does not
claim otherwise.

## Remaining gates

Read `DEVICE_ACCEPTANCE.md`. Active identity/ratchet/pending-send migration,
uncached ciphertext/attachment recovery, new E2EE messaging, P2P calls, original
DSP parity, global PTT/game overlay, native process-exclusive system audio and
seamless rekey/reconnect are not established by the working history/LiveKit slice.
Real phones, Safari/WebKit, Linux/macOS builds, native mobile background/capture
lifecycle, signed installers/store distribution and old-client upgrades remain
separate gates. Android SDK remains absent; macOS/iOS require external hardware.

No production deployment, updater-feed change, schema migration, existing store
mutation, or Go/Rust traffic split was performed.
