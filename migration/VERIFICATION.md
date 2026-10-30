# Local proof receipt — 2026-10-30

Scope: foundational stage 1 only. The rewrite is not complete.

## Passed locally

- Reference snapshot: 338 routes and SHA-256 for six compatibility source files.
- Rust 1.99.1: four protocol/core tests; Clippy with warnings denied.
- Rust client-core: `wasm32-unknown-unknown` compile check.
- Flutter 3.47.9 / Dart 3.13.7: analyzer clean.
- Windows x64 release build with a real native-assets Rust library.
- Two Windows native integration tests: Flutter renders `OK: []` returned by Rust;
  server error codes and malformed-envelope rejection cross the same real bridge.

These are local results, not hosted CI, release publication, updater acceptance,
or end-user acceptance. The core WASM check is not a Flutter web runtime test.

## Open gates — broad port must wait

- Android SDK is absent according to `flutter doctor -v`.
- macOS/iOS require a macOS builder, signing/provisioning and real devices.
- Linux build and X11/Wayland capture have not run on this Windows host.
- No platform has completed old encrypted-history/device-state migration.
- Login, LiveKit/P2P media, DSP parity, system audio, PTT, game overlay and mobile
  background/capture lifecycle are not implemented in this proof.
- No physical-device latency/quality/resource comparison has been performed.
- No old-client upgrade, production cutover or rollback has been exercised.

Initial Cargokit scaffolding required Windows developer-mode symlinks. Native
assets was used instead without changing that OS setting. This does not establish
that later media plugins will avoid the same platform requirement.

Reference source is a committed development checkout, not a verified deployed
release. Shared uncommitted changes were not imported. Existing Go services,
database schemas, E2EE data and release feeds have not been changed.
