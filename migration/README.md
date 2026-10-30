# Rust + Flutter migration — stage 1

This is an isolated proof workspace, not a replacement production server or client.
Reference: committed source `8f443aac23649e8468a320850498e823826a0c5f`.
The shared checkout's uncommitted work is deliberately excluded. This commit is
not asserted to be the currently deployed or fully accepted release.

## Reproduce

```sh
node migration/scripts/baseline.mjs --check
cargo test --manifest-path migration/Cargo.toml --workspace --locked
cargo clippy --manifest-path migration/Cargo.toml --workspace --locked -- -D warnings
```

`protocol` models the existing Go response envelope and WS event header.
`client-core` exposes response inspection for the first bridge proof. It does not
implement authentication, E2EE, durable state, or media. Unknown event operations
remain strings so a new server operation does not break deserialization.

`hichat_native_proof` is generated for all six platforms using bridge 2.13.0
and Flutter 3.47.9. Its native-assets build hook avoids the Windows symlink
requirement of the initial Cargokit scaffold. The ignored `hichat_proof` folder
is that abandoned scaffold, not a second supported application.

```sh
cd migration/hichat_native_proof
flutter pub get --enforce-lockfile
flutter analyze
flutter test integration_test/simple_test.dart -d windows
flutter build windows --release
```

The UI invokes the real Rust protocol inspector and displays `OK: []`.
The integration test checks that exact result through the native bridge.
The generated API retains the template method name `greet`; its input is a JSON
response envelope, not a user's name. Rename with regenerated bindings in the
next bridge API change. This proof never accepts credentials or contacts production.

## Stop gates

Do not port the full server or replace existing clients until every platform has
real proof of login, encrypted historical messages, calls, camera, capture, bridge,
and packaging. A missing credential/device is pending acceptance, never a pass.
No production DB access, migrations, update-feed changes, or deployments are part
of this workspace's initial proof. The existing Go server remains authoritative.

| Platform | Build | Real media/E2EE | Install/upgrade |
|---|---|---|---|
| Windows | pending | pending | pending |
| Linux X11/Wayland | pending | pending | pending |
| macOS | pending | pending | pending signing/notarization |
| Web Chrome/Edge/Firefox/Safari | pending | pending | pending storage migration |
| Android | pending | pending foreground/capture lifecycle | pending signing |
| iOS | pending | pending ReplayKit/background lifecycle | pending provisioning |

Windows requires own-process audio exclusion, PTT and game-only overlay;
web requires keyboard/screen-reader/IME checks. SDK platform support is not
evidence that these HiChat behaviors work. Capture-to-display latency, CPU and RAM
must be measured against the same reference hardware and scenario.

## Compatibility obligations

Preserve REST methods/status/envelopes, null/empty collections, WS ordering and
voice epochs; bcrypt/JWT/refresh/session revocation; PostgreSQL transaction and
migration semantics; encrypted history and pending-send idempotency. Local device
identity/ratchet migration requires exclusive ownership and recovery at the latest
state. Never roll back to an old ratchet snapshot after sending new messages.

Go/Rust servers must not randomly share live traffic: tickets and Hub state are
process-local. Cutover requires a single active writer, scheduler and media owner.
