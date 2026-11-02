# Durable DM retries and explicit session confirmation

`GET /api/dms/send-capabilities` advertises `text_idempotency_version: 1`.
Flutter persists the chosen mode with the pending request before network I/O.
`POST /api/dms/{channelId}/messages/idempotent` requires `client_message_id` and
also accepts multipart requests when `multipart_idempotency_version: 1` is advertised. An old server returns 404; a previously fenced reliable
request never falls back to the ordinary endpoint, including after server rollback.
Old-server 404 responses can be plain text. They are detected before the first
attempt, and new sends retain the old single-attempt/reconciliation path.

The request key is scoped to sender and channel. A SHA-256 hash covers the parsed,
validated request, including ciphertext, sender device, metadata and reply target.
The channel lock serializes receipt lookup and message creation. Message, receipt,
recipient unread count and notification commit together. Replays return the current
original message without another notification, email, unread bump or create broadcast.
Deleted/edited originals and conflicting payloads fail closed. Receipts contain only
IDs and hashes, survive message deletion, and cascade with channel/account deletion.

Rust preserves the exact transport mode/request on retry without deriving keys or
advancing ratchets. Already attempted legacy requests cannot be upgraded into safe
retries. The scheduler resumes persisted idempotent attempts after restart without
opening a conversation. Exponential backoff with jitter, persisted deadlines and
bounded Retry-After prevent tight loops. Permanent rejection pauses automatic
delivery; explicit retry remains available. Logout fences late responses. Transient
initialization failures also back off and recover without opening Messages.

Local checks cover SQLite and PostgreSQL concurrent duplicates, authorization,
conflict/deletion and notification-failure rollback; PostgreSQL also runs the race
detector. Rust tests cover persisted byte/state equality; Flutter tests cover a lost
response and exact retry plus plain-text 404 old-server compatibility.

PostgreSQL migration 052 queues DM message create/update/delete, pin/reaction,
read/status/encryption-state and DM notification creation in their source
transactions. Upload preparation fences create delivery until completion. Startup
recovery must succeed before HTTP serving; interrupted preparation is recovered.
The existing singleton backend owner runs the worker. Failed delivery backs off;
an unpublished channel head prevents later events overtaking it.

Events carry stable namespaced `event_id` and decimal-string `dm_sequence` values.
Acknowledgment means dispatch to the existing WebSocket hub, not device receipt.
At-least-once duplicates can retain the same ID. Authorized participants can use
`GET /api/dms/{channelId}/events?after=0` for bounded catch-up. Published events are
retained for seven days; an expired/future cursor requests a history reset.
Original create/edit wire snapshots preserve prekey-envelope order even when an
edit precedes dispatch. Deletion erases all stored message snapshots and suppresses
stale create/update replay. Channel deletion cascades the queue. Historical SQLite
imports do not create a delivery backlog.

Typing/presence and channel lifecycle signals are outside this durable queue.
The Flutter preview still polls message history; the real WebSocket integration
test independently verifies delivery and REST replay IDs. Physical-device acceptance remains open.
Earlier evidence retains its original source hashes. See `evidence/dm-outbox.json`
for this increment's scoped Windows/web verification.

## Multipart delivery — 2026-11-02

`multipart_idempotency_version: 1` extends the dedicated idempotent endpoint.
The server computes an ordered manifest of actual uploaded bytes (SHA-256),
normalized filename, size and recorded MIME. It never trusts a client-supplied
manifest. Files are fully copied/synced before the message transaction; message,
attachment rows/order, receipt, unread and notifications commit together. A failed
stage cannot create a partial message. Same key with different bytes/order or an
edited/deleted original fails closed. A duplicate returns the original attachment
IDs without another upload row, unread increment or create event.

Concurrent requests may stage independent temporary files. An unknown message or
attachment commit result retains staged bytes for the maintenance grace; a missing
reference immediately after a DB error is not proof of rollback. Cleanup checks committed
references before removing its own files, including post-commit HTTP failures.
The singleton backend owner also reclaims only `dmstage_` files older than 24 hours
without a committed reference. Fresh files, directories/symlinks, unrelated names
and committed files are retained. Abrupt power/storage failures remain separate
acceptance gates; a successful synthetic run is not a filesystem durability proof.

Flutter/Rust encrypt each file once using the legacy AES-256-GCM/file_keys format.
The protected pending record retains encrypted file bytes and metadata until ACK;
retries rebuild multipart framing around the same payload/parts. HTTP boundary
strings may differ, so retry evidence compares fields and exact file bytes, not
raw multipart framing. No file key is sent outside the encrypted message. Old
servers cannot receive these sends through an unsafe fallback. The preview's
picker is limited to ten files, 1 MiB each and 2 MiB total; existing server upload
limits remain configurable. Secure file opening, larger-file/thumbnail parity and
uncached historical recovery remain W3, not physical-device test excuses.

## Explicit session confirmation

An authenticated initial envelope conflicting with a live session stays blocked.
The review is stored in the protected vault and bound to owner/device, exact
message and current ratchet fingerprint. Before the dialog, renewal authenticates
it again; the dialog shows both identity fingerprints. Approval requires the
verification checkbox, a matching current public-device record, local device
ownership and a fresh five-minute state binding. Identity changes cannot be
accepted through this operation. Logout fences pending UI/network completions.
Cancellation leaves ratchets and the blocked review unchanged.

Approval archives the superseded receive state instead of discarding it. For
simultaneous first sends, both sides choose the same initiating device by device-ID
order. Delayed old-chain packets advance only their archived state; persisted
outbound ciphertext is unchanged. A bounded archive refuses further replacement
at capacity; it never evicts or restores an older ratchet silently. Existing replay
and trusted-identity checks remain in force. See `evidence/dm-attachments-session.json`
for scoped Windows/web results.
