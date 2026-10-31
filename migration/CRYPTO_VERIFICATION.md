# Cryptographic transition verification — 2026-10-31

Scope: platform-independent Rust kernels for the existing HiChat message protocol.
This is not an active-device handoff receipt, a storage atomicity result, a
live old/new-client acceptance result, or an independently audited new protocol.

## Reference execution

`ratchet-fixture.mjs` runs the repository's existing `signalProtocol.ts` and
`senderKeyProtocol.ts` after Node's type stripping. It replaces only imports for
synthetic in-memory storage/auth and resolves the existing Noble dependencies.
No production IndexedDB, account, key material or browser profile is read.
The fixtures contain newly generated test-only private keys, never production keys.

The committed fixtures cover 11 established-ratchet transitions (including DH turns,
out-of-order delivery and a historical JSON-AAD frame), eight X3DH/first-message
cases (3-DH and 4-DH), and six signed Sender Key transitions including historical
out-of-order reads from a legacy-version inbound distribution. Rust output wire
bytes and next-state objects are compared exactly. Both the implementation source
and `types.ts` normalized SHA-256 hashes are checked by the Rust test suite.

Fixture regeneration uses Node 26.13.0 here. Pass `--node-modules ABSOLUTE_PATH`
when reference client dependencies are not installed under `client/node_modules`.
A sibling original checkout's dependencies may be read as a local fallback; they
are never edited or installed by the fixture generator. Ordinary Rust tests use
committed fixtures and need no Node dependencies.

## Failure behavior

Transitions operate on cloned state and return a new state only after successful
cryptographic processing. Tests cover damaged messages/signatures, consumed skipped
keys, replay, exhausted counters, low-order DH inputs, missing OTPs, signing-key
rotation and unauthorized outbound use of legacy Sender Keys. Secret key byte
buffers and transient base64 key encodings use zeroization. No secret-key Debug
implementations or diagnostic logging is added to the production kernels.

The caller remains responsible for fresh OS/browser entropy, account/device/trust
binding, durable state plus pending-send commit before network dispatch, and an
exclusive ownership handoff. These requirements are not satisfied by a passing
pure-kernel test. The separate DeviceVault adapter now supplies protected storage,
source retirement and durable peer preparation; see HANDOFF.md and its evidence.

## Compatibility limits still requiring integration

- Import adapters must preserve metadata, pending payloads/files, trust and replay
  evidence. Recovery backups omit active outbound Sender Key signing metadata and
  are not substitutes for a full frozen source export.
- Rust rejects more than 1000 total skipped DM keys; the reference applies its
  1000 limit per jump. Oversized legacy states must be handled explicitly by the
  future import adapter, without deleting their history or silently clearing keys.
- Ed25519 verification is strict; malformed/noncanonical signatures and keys fail
  closed. Valid reference-generated signatures are byte-compatible.
- Missing declared OTPs and partial prekey bundles fail before state creation.
- Local restart, source retirement, exclusive storage and pending-group rewrap now
  have integration tests. Full old/new delivery, all abrupt process/power-loss
  boundaries and actual multi-device migration remain open.

## Local result

19 ordinary Rust workspace tests pass; the two existing Win32 helper/runtime tests
remain ignored in this run. Clippy with warnings denied and portable WASM core
compilation pass. The earlier native 0x0 failure is repaired by the pinned capture
options and Start-result patch. Windows preview is 320x200 and the strict direct
native/browser test now decodes video plus positive synthetic audio both ways.
The verified pub archive matches the cached screen-capture source exactly
(`flutter_webrtc` 1.6.3 archive SHA-256
`b98ef03376401e54ff87fc78907b38e562b15ca8424aba589c263eddc3c1ecf9`).

Historical note: Computer Use had stopped further native-window inspection because its automatic
browser URL check could not identify the synthetic Chrome window's URL with enough
confidence. No alternate UI/screenshot route was used after that stop. Independent
Rust/CLI tests continued. The subsequent fixture uses an explicit loopback-served
synthetic source URL and SDK capture tests; no physical-device or real-game pass
is claimed. See evidence/device-handoff-capture.json for current results.
