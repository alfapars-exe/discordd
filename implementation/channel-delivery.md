# Channel delivery and PostgreSQL runtime

Product startup requires PostgreSQL 18 with the existing verified mutual TLS
configuration. `DATABASE_PATH` and libSQL are no longer product backends.
`database.NewLegacy` and historical SQLite migrations remain for offline import
and migration fixtures. `migrate-postgres` still verifies imported content hashes
and relationships before committing into an isolated rehearsal schema.

## Send contract

New channel clients send `client_message_id` in JSON or multipart. The durable
identity is `(user_id, channel_id, client_message_id)`; its request hash covers
content, reply, encryption fields and ordered file names/types/bytes. Concurrent
identical sends reuse the original row, different payloads return 409, and a
deleted message leaves a tombstone preventing recreation. Older clients may omit
the identity but have no automatic retry protection.

HTTP success acknowledges durable message storage. It is not a recipient-device
delivery receipt. The client retains the identity and prepared ciphertext after
an uncertain failure until the draft changes or the send succeeds. Account/session
changes clear pending intents. This in-memory intent retention does not survive an
application restart.

Attachment slots are persisted as preparing/ready/failed. The attachment row and
ready slot transition commit together. Successful slots are never uploaded again
by an identical replay. File-key indices survive partial failures. Active handlers
refresh preparing slots every 10 seconds; abandoned slots fail after one minute.
Startup recovery, before HTTP serving, fails preparations left by the previous
singleton process. Final publication waits for terminal attachment preparation.

## Publication and recovery

PostgreSQL triggers record message creates, edits, deletions and channel
mention/reply notification events in the mutating transaction. Each channel has a
durable event sequence, separate from the WebSocket transport counter. A worker
leases pending events for 30 seconds, preserves message mutation order independently
from personal notification backlog, and retries publication
with a delay capped at five minutes. Failed events remain in the queue. A crash
after enqueue but before acknowledgement can duplicate an event with the same ID.

`GET .../channels/{id}/message-events?after_sequence=N` replays at most 100 events,
filters personal notifications, and checks current channel read permission before
and after hydration. Zero/expired cursors return a snapshot reset and current
cursor. Successfully published events older than seven days are purged in bounded
batches. Failed work is retained. Clients serialize durable channel events,
dedupe event IDs and reject older versions of the same message; reconnect retains
the existing snapshot repair and adds cursor replay for cached channel histories.

`GET /api/admin/channel-delivery/health` exposes pending/preparing/retrying event
counts, oldest pending age and maximum attempts to platform administrators.

## Read state and process ownership

Message source sequences, history pagination and read watermarks share one channel
order. PostgreSQL read counts query real messages after the watermark, excluding
the reader's own messages. Deletion cannot invalidate the numeric watermark.
There is no per-reader write fan-out on message creation/deletion. Mention counts
remain independent of notification feed pagination.

The backend holds a dedicated PostgreSQL advisory-lock connection for its lifetime.
A second backend cannot start serving. Ownership is probed every second with a
two-second timeout; failure exits the process immediately after logging. At least
two application pool connections are required. This is a single-backend policy,
not distributed presence, voice ownership or cross-instance WebSocket fan-out.

## Rollout and acceptance

1. Preserve a PostgreSQL snapshot and uploaded-file backup; rehearse migration 049
   on a copy. Compare message, attachment, mention and read-watermark results.
2. Stop the previous backend before starting the new one. Do not use overlapping
   rolling replicas; older binaries do not participate in the singleton lock.
   The reviewed HF publisher pauses the Space and confirms PAUSED before committing
   sources, then explicitly restarts it. Preview and invalid plans never pause it.
3. Deploy the backend first, inspect readiness and channel-delivery health, then
   publish the client/Windows updater. Older clients remain accepted.
4. Verify lost HTTP responses, reconnect, partial attachments, edits/deletions and
   authorization changes with two actual clients. Automated tests and reachable
   update artifacts are separate evidence from this device acceptance.

Portable timestamp/upsert statements are explicit SQL. PostgreSQL history, unread
counting, metrics aggregation and repository expressions use native SQL selected
at the repository boundary. The driver only binds parameters and preserves native
migrations; it does not translate SQLite expressions.

The Playwright launcher now requires `HICHAT_E2E_POSTGRES_DSN` pointing to a
verified-mTLS loopback `hichat_e2e_control` database. Each run creates/drops its own
database; the read-only queue observer validates the run descriptor and uses a
read-only transaction. CI provisions this control instance using
`scripts/start-e2e-postgres.sh`. Production credentials and DATABASE_URL are never
used by this fixture.
