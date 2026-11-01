# Active-device handoff — Windows/web storage implementation

See [STATUS.md](STATUS.md) for the current inventory. The 2026-11-01 text-DM slice
connects this vault to fresh registration, Rust X3DH/ratchets, fanout, source-bound
imported history and the Go API. Legacy-to-Windows and legacy-to-web transfers both
continued live two-way conversations locally. Group/channel dispatch, attachments
and complete delivery/crash/device acceptance remain open.

The proof now connects source retirement, protected persistent target storage,
exclusive ownership and durable peer-ratchet preparation. Ordinary recovery
backups remain read-only. No production device, store, service or update feed was
changed by the disposable local tests.

## Implemented storage and ownership protocol

1. The target protects a fresh X25519 transfer private key before showing its
   public code. The legacy Security panel checks account/backend, key pairs,
   supported ratchet states and registered identity/signed prekey. The decoded
   export is bounded to 32 MiB; unsupported non-exportable keys fail preflight.
2. The source account IndexedDB upgrades from v1 to v2. Every old connection must
   close before the upgrade commits. A non-cooperating tab blocks retirement;
   a timed-out request cannot silently upgrade later. Updated connections close
   on versionchange. Afterward even unpatched v1 openers fail with VersionError.
   Existing crypto sends persist advancement before returning wire bytes, so
   transactions drain before the snapshot and later writes fail closed. Already
   transmitted requests are not retracted.
3. A frozen marker permits interrupted retry. The encrypted capsule and final
   retirement marker commit together before download. The same target gets the
   identical capsule on retry; another target is rejected. Original rows remain.
   There is no schema downgrade or old-ratchet rollback.
4. X25519 + HKDF-SHA256 + AES-GCM bind the capsule to backend, account, source
   device, intent and target key. All key stores, sender-signing metadata, trust,
   cache and captured preferences are retained. The source runtime decrypts
   non-exportable pending-group envelopes, preserving request IDs, prepared
   ciphertext and attachment metadata/bytes for target re-protection. Unpersisted
   DM/channel operations and in-memory drafts are not invented as a durable queue.
5. Rust authenticates and validates identity, signing keys, prekeys and ratchets.
   The authenticated Go device roster must match identity and verify the imported
   signing key against its signed prekey; the existing endpoint has no signing_key
   field. A protected dormant record is read back before activation. Dormant restart
   resumes verification; active reopen rechecks the roster.
6. Windows uses DPAPI with account/backend entropy, a lifetime exclusive file lock,
   synced protected temporary files and MoveFileExW replacement/write-through.
   Web uses non-exportable AES-GCM, encrypted IndexedDB, transactional revision CAS
   and a lifetime Web Lock. Unsupported browsers/platform keystores fail closed.
   No plaintext snapshot is written to disk. Origin eviction remains a web limit.
7. preparePeer commits next ratchet state and prepared request before returning
   wire bytes. Same ID/payload returns identical ciphertext after restart; a
   conflicting payload is rejected. Auth invalidation drains work/releases the
   owner and prevents old-account results from reaching the caller.

These are local storage fences for product workflows, not a server-authoritative
lease or protection against manual whole-profile rollback or compromised same-origin
code. After activation, the old client needs a fresh device identity. DeviceVault
is a peer-envelope/storage driver, not the complete chat dispatcher, recipient
fanout, receive orchestration, pending-group retry UI or TOFU interface.

## Local reproduction and outstanding acceptance

Use the disposable Go API on 19090 and proof-server.mjs on 18080; never production.

```powershell
node client/node_modules/vitest/vitest.mjs run --root client --config handoff.vitest.config.mts --configLoader native
node client/node_modules/vitest/vitest.mjs run --root client --config storage-regression.vitest.config.mts --configLoader native
node migration/scripts/build-handoff-source.mjs
node migration/scripts/prepare-handoff-qa.mjs
# Stop if fixture preparation fails, including registration rate limiting.
# Start handoff-native-source-qa.cjs in a second shell, then:
cd migration/hichat_native_proof
flutter test integration_test/device_handoff_test.dart -d windows --dart-define=HICHAT_QA_FILE=ABSOLUTE_PATH_TO_HANDOFF_QA_JSON
```

For web, prepare a fresh account and import scripts/handoff-browser-qa.mjs through
ego-browser nodejs. It uses the shared task space, actual source export/Flutter
activation, second-tab exclusion, reload, non-exportable storage, encryption-failure
injection and stale-revision CAS. Finish the space after remaining browser checks.
Private fixtures remain in ignored .local; latest sanitized evidence is in
evidence/device-handoff-capture.json.

Text-DM old/new send/receive/fanout and DH turns now have local evidence. Still
outstanding: full channel/group orchestration, server-backed idempotent pending
delivery/acknowledgment, abrupt process/power loss at every boundary,
actual multi-device migration, attachment-opening UI, Safari storage behavior and
physical device/media acceptance. Local storage and synthetic tests do not close
those gates.

## Historical gate recorded before this implementation

The following rationale and full-product acceptance requirements predate the
storage implementation above. They remain useful for the complete migration;
the old absence of a freeze/store adapter is superseded.

The Go signaling/media API remains the reference; no production device has been
retired, re-registered or moved by the proof client.

## Why an existing recovery backup cannot activate a device

`client/src/crypto/keyBackup.ts` collects an account-bound recovery snapshot.
That snapshot is not a live ownership receipt. The original client may advance
its DM ratchets and channel sender keys after the snapshot. Importing those
sending chains into a second writer can reuse message keys. A successful
AES-GCM decrypt is insufficient authorization to send with the same device ID.

The source IndexedDB also contains non-exportable pending-send protection keys.
Copying their ciphertext into another runtime would strand pending requests.
The existing source runtime must decrypt those records, preserve request IDs and
already-prepared encrypted payloads, and protect them in the target store.

## Required implementation sequence

1. Cryptographic transition kernels are now ported and cross-checked: X3DH
   3-DH/4-DH and first-message envelopes, DM chain/DH ratchets, skipped keys,
   canonical/legacy header authentication, signed Sender Key frames, historical
   anchors and replay checks. Twenty-five synthetic reference cases match the
   existing TypeScript implementation. These pure kernels are not yet wired to
   atomic storage, account/device orchestration, TOFU UI or Flutter sends. Their
   presence does not grant permission to activate an imported sending identity.
2. Add a durable source freeze barrier shared by every old-client crypto writer
   and every send/retry path; drain transactions and in-flight sends. Closing a
   window or observing a disconnected socket is not proof of this barrier.
3. Export an account/backend/device-scoped, authenticated transfer capsule after
   that barrier. Include live ratchets, sender keys, trust, one-time prekeys,
   pending sends, preferences, a monotonic generation and an immutable digest.
4. Import into a dormant target transaction, re-protect secrets, verify contents
   and fsync/commit the receipt. No target send is allowed at this point.
5. Persist the source retirement tombstone before granting the target ownership.
   Fence stale tabs/processes, retries, snapshots and already-running async tasks.
   Resume interrupted transfers from receipts, without two active writers.
6. Permit rollback only before activation. After activation, the former client
   must obtain a fresh device identity; never restore its old sending ratchets.

## Required acceptance

- Bidirectional old/new DM and channel messages before and after handoff, including
  a DH turn, skipped/out-of-order messages, sender-key replay rejection and history.
- Crash/restart at every durable transition, concurrent tabs/processes, logout or
  account switch during export/import, duplicate/altered transfer receipts.
- Pending channel/DM/group sends retain their original idempotency IDs and encrypted
  request bytes, with neither loss nor duplicate visible messages.
- Target advancement permanently prevents reuse of the source's sending state.

The proof UI intentionally offers only history recovery until these gates pass.
