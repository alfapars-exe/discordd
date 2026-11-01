# HiChat Rust/Flutter Windows/web preview 1.0.3

This portable preview is separate from the installed HiChat desktop application.
Extract the entire ZIP and run hichat_native_proof.exe; keep its DLL/data files.
It does not replace the normal installation or its automatic-update feed.

Implemented: Go login/MFA, read-only recovery history, encrypted SFU media,
direct-call adapter, Windows capture/audio/HUD proof, and protected device-handoff
storage with single-owner ratchet preparation. Text DMs now connect fresh devices,
peer/sibling fanout and imported history to Rust and the existing Go API. Actual
legacy protocol code transferred live conversations to both Windows and web.

Version 1.0.3 negotiates durable text-DM idempotency. With a supporting Go server,
uncertain sends can resume with the exact saved ciphertext through a dedicated
endpoint. Old-server sends retain the single-attempt/history-reconciliation policy;
already uncertain legacy sends are never upgraded into replayable requests.

The complete channel/group/attachment UI, all crash boundaries, real devices,
signing/installer, Safari and other native platforms have not passed acceptance.
Use a disposable account. Do not retire a real encryption device into this preview:
the full messaging workflow is unfinished (see STATUS.md). The legacy export UI is disabled in
normal builds; development builds can explicitly set
VITE_ENABLE_DEVICE_HANDOFF_PREVIEW=true for the disposable handoff fixtures.

Web ZIP deployments require COOP same-origin, COEP require-corp and application/wasm.
This web package uses Dart JavaScript plus Rust WASM, not the optional Dart-WASM
renderer. See migration/HANDOFF.md and DEVICE_ACCEPTANCE.md in the source release.

After a preview handoff, keep the target's protected store. Never restore an older
ratchet snapshot or copy the same active device into a second independent profile.
