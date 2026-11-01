# Windows/web verification

## Durable text retry increment — 2026-11-01

See DM_DELIVERY.md. Twenty-nine Rust tests and 23 Flutter tests pass locally;
two Rust window helpers remain ignored in the ordinary suite. SQLite and local
PostgreSQL tests verify concurrent duplicates, payload conflict, current membership/
block authorization, deletion tombstones and atomic notification-failure rollback.
PostgreSQL also passes the Go race detector in a local Linux container. Windows
and web release builds pass. Physical-device acceptance remains open.

## Current text-DM increment — 2026-11-01

See STATUS.md and evidence/chat-handoff.json. Fresh Windows devices exchanged
encrypted DMs through the real Go/PostgreSQL API and reopened their DPAPI stores.
The actual legacy TypeScript implementation then exchanged messages with Rust,
retired its source, and transferred live state to Windows and web targets. Both
continued the same ratchet/device, including old source-tagged history and new
two-way DH turns. The web target also passed reload/history and logout clearing.
The web fixture's native peer resumed after an automation timeout; this is recorded
as a restart, not hidden as an uninterrupted run. Physical devices remain separate.

28 Rust tests and 22 Flutter tests passed locally; two hidden-window Rust helpers
remain explicitly ignored in the ordinary suite. Native integration tests and the
ego-browser flow are additional evidence, not replacements for physical acceptance.
The older dated sections below describe historical proof boundaries.

## Latest storage/capture increment — 2026-10-31

The active-device proof now has durable source v2 retirement, target-bound encrypted
capsules, pending-group key rewrap, protected Windows/web storage and exclusive
ownership. The native integration verifies dormant restart, original pending request
and cached history/preferences, same-ID ciphertext reuse, conflicting retry rejection
and ratchet counter continuation. See HANDOFF.md for scope and remaining software
gates; this is not full old/new chat delivery acceptance.

The Windows 0x0 capture defect is fixed using the pinned libwebrtc options API:
focus_window=false and WGC support, while retaining OS capture borders/permissions.
The plugin's previously ignored Start result is checked and failed capture cleans
up rather than reporting success. CMake patches a SHA-verified build copy and bundles
the SDK license; the shared Pub cache stays unchanged. The strict P2P test now
requires decoded native-to-browser video, positive audio and connected DTLS as well
as the reverse direction. Latest sanitized evidence and source/build hashes are in
evidence/device-handoff-capture.json. Older receipts below retain their historical
failures and must not be used as current acceptance.

Current checks include 20 ordinary Rust tests, seven source-handoff tests, 64 existing
storage regressions, ten Flutter tests, TypeScript/analyzer/Clippy, Windows release and JS-rendered web with
Rust WASM. Actual Flutter web activation/second-tab/reload and injected storage
faults are checked separately from physical devices. Native Android/iOS/macOS/Linux,
real Safari, camera/microphone, long calls and real-game acceptance remain open in
DEVICE_ACCEPTANCE.md. No production deployment/update is implied.

## Historical Windows/web receipt — 2026-10-30

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

## Incremental media work — 2026-10-31

- Added a direct WebRTC call adapter and Flutter call UI using the existing Go
  ticket/WS/call authorization contract. Microphone/camera capture starts after
  acceptance. Auth invalidation, hangup, transport failure and deadlines release
  owned tracks and peer connections. The initial microphone/camera contract is
  implemented; P2P screen-source negotiation, TURN deployment and mid-call
  renegotiation remain separate work.
- Two isolated Chromium peers passed real Go call authorization, no capture while
  ringing, bidirectional decoded video plus positive synthetic-tone audio energy,
  connected DTLS transports and hangup closing both peers. This test found and
  fixed SDK muting caused by tagging a remote stream as local.
- Added opt-in screen audio. Windows uses the SDK's WASAPI application/system
  loopback support. The UI only offers screens when system audio is requested;
  unsupported or absent audio publication fails and stops sharing. A disposable
  owned Chrome window generated a tone; Windows captured that application's audio
  and published it through the encrypted room. The browser receiver measured
  positive audio energy; stopping removed the audio publication. This is not a
  full-desktop own-process-exclusion, headphone feedback or long-call acceptance.
- Added a Rust Win32 HUD bound to a locally selected external window. It carries
  voice/mute/share status, uses no-activate/click-through/tool-window styles, and
  hides when the selected game is not foreground. The explicit hidden-window
  runtime test passed without capturing user media or changing foreground focus.
  Visible gameplay, exclusive fullscreen, anti-cheat compatibility, DPI/multi-monitor
  geometry and global PTT remain unaccepted.
- Eight ordinary Rust tests pass; the separately invoked hidden Win32 runtime test
  also passes (its helper test stays ignored during ordinary runs). Clippy and
  portable WASM core check pass. Ten Flutter tests and analyzer pass.

Active device/ratchet handoff is **not implemented**. This is an implementation
limitation, not a missing physical-device test. See `HANDOFF.md` for source-bound
prerequisites and crash/concurrency acceptance. No old device store is modified.

Reproduction additions:

```powershell
cargo test --manifest-path migration/Cargo.toml -p hichat-client-core --release overlay::tests::hidden_window_runtime -- --ignored --exact
node migration/scripts/p2p-browser-qa.cjs
# Start native-audio-qa.cjs, then run native_audio_test.dart on Windows.
# Start native-p2p-qa.cjs, then run p2p_peer_test.dart on Windows.
```

Local scripts use the existing loopback-only fixture host and disposable Go API.
Native audio fixtures create only their own Chrome source window and do not capture
an existing user window. They produce no recording of user media. Read individual
receipts for the final status of the Windows-to-browser direct-call test.

### Windows direct-call result and failed video direction

The native/browser fixture verifies **bidirectional synthetic audio and
browser-to-Windows video**, not bidirectional Windows video. The broader initial
attempt failed: the browser decoded zero frames from the native SDK's synthetic
window source, while its audio energy was positive. Bringing that owned source
window to the foreground did not resolve the video direction. The final scoped
test explicitly retains the browser's frame count in its receipt. Native outbound
window capture/camera interoperability remains an open implementation/acceptance
item; the narrowed test is not evidence that this failed direction was repaired.

Final scoped native P2P receipt: Windows decoded 16 browser video frames and
positive audio energy; the browser received positive native audio energy over
connected DTLS, with zero native window-video frames. Desktop/Android-UA/iPhone-UA
Chromium login, Rust history and logout clearing were rerun successfully after the
final web build. Sanitized results and source/runtime hashes are in
`evidence/windows-media.json`; no physical-device or release claim is implied.
