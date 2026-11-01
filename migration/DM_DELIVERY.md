# Durable text DM retries

`GET /api/dms/send-capabilities` advertises `text_idempotency_version: 1`.
Flutter persists the chosen mode with the pending request before network I/O.
`POST /api/dms/{channelId}/messages/idempotent` requires `client_message_id` and
rejects multipart requests. An old server returns 404; a previously fenced reliable
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
test independently verifies delivery and REST replay IDs. Multipart idempotency,
simultaneous-session confirmation and physical-device acceptance remain open.
Earlier evidence retains its original source hashes. See `evidence/dm-outbox.json`
for this increment's scoped Windows/web verification.
