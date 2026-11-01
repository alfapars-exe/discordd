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
retries. The UI offers explicit retry only for persisted idempotent attempts.

Local checks cover SQLite and PostgreSQL concurrent duplicates, authorization,
conflict/deletion and notification-failure rollback; PostgreSQL also runs the race
detector. Rust tests cover persisted byte/state equality; Flutter tests cover a lost
response and exact retry plus plain-text 404 old-server compatibility.

This does not implement automatic retry scheduling, multipart idempotency,
transactional WebSocket event delivery, simultaneous-session confirmation or
physical-device acceptance. Earlier chat-handoff evidence describes its original
source hashes and is not relabeled as a fresh end-to-end device run.
