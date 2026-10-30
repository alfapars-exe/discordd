# Active-device handoff: implementation gate

Status on 2026-10-31: **not implemented and not enabled**. This is a software
work item, separate from physical-device acceptance. History recovery does not
transfer a live encryption device.

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

1. Port and cross-check the existing Signal/X3DH/Double Ratchet and Sender Key
   send/receive engines, replay windows, skipped keys, anchors, trusted identities,
   device registration and authenticated headers. Rust currently implements the
   recovery-history reader, not these engines.
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
