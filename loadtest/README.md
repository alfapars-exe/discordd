# WebSocket connect load test (k6)

For the repository-owned Windows PostgreSQL workload and independent history
audit, see [LOCAL_PROFILE.md](LOCAL_PROFILE.md).

`ws_connect.js` opens many concurrent WebSocket connections against the
HiChat server's real connect path — `POST /api/auth/login` ->
`POST /api/auth/ws-ticket` -> `GET /ws?ticket=...` — holds each connection
open with periodic heartbeats, and reports handshake success rate plus
connection/session timing.

k6 is a standalone CLI (https://k6.io/), not a project dependency. It is not
added to `go.mod` or `package.json` — install it separately (e.g. `choco
install k6`, `brew install k6`, or download a release binary) and invoke it
directly.

## IMPORTANT — local/dev only

This script's default `BASE_URL` is `http://localhost:9090` (the server's
local dev default, see `config.ServerConfig` / `SERVER_PORT`). **Never**
point it at the HuggingFace Space (production) deployment or any other
server you don't control — no production domain is hardcoded anywhere in
this script, on purpose, so there is no accidental default to guard
against. Only override `BASE_URL` to another host you own and intend to
load-test.

## IMPORTANT — `/api/auth/ws-ticket` is rate-limited and single-use

Two production constraints shape how you must run this against any
non-trivial VU count:

1. **Per-IP rate limit.** `handlers/auth.go`'s `wsTicketLimiter`
   (added 2026-05-27, P1-BC-07) caps `/api/auth/ws-ticket` issuance per
   source IP. A k6 run from a single machine is a single IP, so pushing
   `WS_VUS` much past the limiter's window will start getting `429`s on the
   ticket step, not the WS connect itself.
2. **Tickets are one-time-use.** `services/ws_ticket_service.go` issues a
   ticket that is consumed on first use — you cannot reuse one ticket
   across multiple connections, and a login+ticket pair only gets you one
   WS session.

Two ways to work around this for a real multi-hundred-VU local run:

- **Seed multiple users** and set `USER_COUNT` / `USERNAME_PREFIX` (see
  below) so each VU authenticates as its own account
  (`${USERNAME_PREFIX}${index}`, all sharing `PASSWORD`). This spreads
  login/ticket issuance across accounts instead of hammering one, but the
  per-IP rate limit still applies to the whole run since every VU shares
  one source IP in a typical local setup — tune `WS_VUS` against whatever
  window the limiter allows, or space out the ramp-up (`RAMP_UP`).
- **Reuse a single access token via the legacy path.** Set
  `USE_LEGACY_TOKEN=true` on the k6 side AND run the target server locally
  with `HICHAT_ALLOW_LEGACY_WS_TOKEN=1`. The script then skips the
  ws-ticket exchange entirely and opens `GET /ws?token=<access_token>`
  directly (see `ws/handler.go` `HandleConnection`'s legacy branch), which
  has no single-use restriction and isn't behind the ws-ticket limiter.
  `HICHAT_ALLOW_LEGACY_WS_TOKEN` is a dev/local-only escape hatch — never
  set it on a production server.

## Prerequisites

- k6 installed and on `PATH`.
- A HiChat server running locally (or on a dev host you control) with at
  least one account you can log in as.

## Running

```sh
# Single seeded account, default profile (~200 VUs, 30s ramp / 60s hold / 20s ramp-down)
k6 run -e USERNAME=myuser -e PASSWORD=mypassword loadtest/ws_connect.js

# Multiple seeded accounts (loadtest0..loadtest49), smaller VU count
k6 run -e USER_COUNT=50 -e USERNAME_PREFIX=loadtest -e PASSWORD=loadtest-password \
  -e WS_VUS=50 loadtest/ws_connect.js

# Legacy-token reuse (requires the target server started with
# HICHAT_ALLOW_LEGACY_WS_TOKEN=1)
k6 run -e USE_LEGACY_TOKEN=true -e USERNAME=myuser -e PASSWORD=mypassword \
  loadtest/ws_connect.js
```

Every setting can also be exported as a shell env var instead of passed via
`-e`; k6 reads both the same way (`__ENV.NAME`).

## Environment variables

| Variable          | Default                   | Meaning |
|--------------------|---------------------------|---------|
| `BASE_URL`         | `http://localhost:9090`   | HTTP(S) base URL of the server under test; the WS URL is derived from it (`http`->`ws`, `https`->`wss`). |
| `USERNAME`         | `loadtest`                | Login username, used when `USER_COUNT <= 1`. |
| `USERNAME_PREFIX`  | `loadtest`                | Prefix for per-VU usernames when `USER_COUNT > 1` (VU *i* logs in as `${USERNAME_PREFIX}${i}`). |
| `PASSWORD`         | *(required)*              | Password shared by all accounts used in the run. The script aborts if it is unset — there is deliberately no default. |
| `USER_COUNT`       | `1`                       | Number of pre-seeded distinct accounts to spread VUs across. |
| `USE_LEGACY_TOKEN` | `false`                   | `true` to bypass the ws-ticket exchange and connect with `?token=<access_token>` — see the rate-limit section above. |
| `WS_VUS`           | `200`                     | Target concurrent connections during the hold stage. |
| `RAMP_UP`          | `30s`                     | Ramp-up stage duration. |
| `HOLD`             | `60s`                     | Hold-at-target stage duration. |
| `RAMP_DOWN`        | `20s`                     | Ramp-down stage duration. |
| `HOLD_SECONDS`     | `90`                      | How long each VU keeps its own WS connection open before closing it itself. Should be roughly `RAMP_UP + HOLD` (in seconds) so a connection opened early in the ramp survives through the hold window. |

## What it measures

- `checks` — includes login success, ws-ticket issuance (unless
  `USE_LEGACY_TOKEN=true`), and WS handshake (HTTP 101) success. Threshold:
  `rate==1.0` — any failure anywhere in the chain fails the run.
- `ws_connecting` (k6 built-in) — time to complete the WS upgrade
  handshake. Threshold: `p(95)<1000` (ms).
- `ws_session_duration` (k6 built-in) — how long each WS session stayed
  open. Threshold: `p(95) > 90% of HOLD_SECONDS` — a value far below that
  means connections are being cut short (e.g. by a server-side slow-client
  disconnect) instead of holding for the intended window.
- `heartbeat_acks_received` (custom counter) — number of `heartbeat_ack`
  events received; sanity-checks that the heartbeat round-trip
  (`ws/client_dispatch.go` `handleHeartbeat`) keeps working under load.

## Why this exists

This complements the Go benchmarks in `server/ws/hub_broadcast_bench_test.go`
(`BenchmarkBroadcastToServer_SlowClients` — the in-process regression guard
for the thundering-herd goroutine-leak class of bug in
`Hub.BroadcastToServer`). Where that benchmark proves the *fan-out*
broadcast path doesn't leak goroutines per slow client, this script exercises
the *connection* side end-to-end — real HTTP auth, real ticket issuance,
real WS upgrades, and real concurrent connection volume — which the
in-process benchmark deliberately does not attempt (it constructs `*Client`
values directly rather than going through the network).

## Contract verification

Run `node --experimental-vm-modules --test loadtest/ws_connect.test.mjs` from the repository root. CI executes this dependency-free suite with mocked k6 imports while evaluating the actual load script. These tests verify the current `success/data` response envelope, required nonempty string credentials, zero-session failure, early close/connect failure, one measured connection per VU and numeric configuration. They are not a real k6 or server throughput result.

Each VU opens one measured connection. Subsequent executor iterations sleep for one second without logging in again. `ws_handshakes_succeeded` and `ws_sessions_succeeded` must each match `WS_VUS`; a run that never opens a WebSocket cannot pass on successful HTTP checks alone. Every session must complete its configured hold without socket errors. The scenario allows up to `HOLD_SECONDS + 5` seconds of graceful stop/ramp-down for in-flight connections. Short smoke profiles below the 30-second heartbeat interval do not establish heartbeat acceptance.

Example bounded local smoke: `WS_VUS=1 USER_COUNT=1 RAMP_UP=1s HOLD=36s RAMP_DOWN=1s HOLD_SECONDS=35`. Use an isolated disposable backend and a freshly seeded local account; pass its password through the environment. This is contract/liveness evidence, not a capacity/SLA claim. No production endpoint should be used for this profile.

## Bounded multi-account resource profile

A recorded local profile uses 20 distinct seeded ordinary accounts, the real login/ticket path, `WS_VUS=20 USER_COUNT=20 RAMP_UP=10s HOLD=60s RAMP_DOWN=10s HOLD_SECONDS=75`. Supply `PASSWORD` through the environment and set `USERNAME_PREFIX` to the owned fixture's prefix. Limits remain enabled. Every connection spans two 30-second heartbeats; expect exactly 20 completed sessions and 40 ACKs. Authentication and session checks remain mandatory.

The November 16 diagnostic used a normal Windows Go1.27.4 backend built from immutable `221f19df`, k6 v2.4.0 and an isolated PostgreSQL18.6 database with verified mutual TLS. A separate synthetic platform admin sampled pprof; load users were not platform admins. It passed 100 checks, observed 20 simultaneous read/write pump pairs and zero pairs in all six recovery samples. Samples and limitations are in `implementation/verification/refactor-ws-20-session-profile-2026-11-16.json` and its companion samples artifact.

This is one connect/heartbeat resource profile, not a throughput/SLA or extended-soak result. No guild/channel workload, message fan-out, slow-consumer or media traffic was applied; effective memberships were not separately queried. Profiling overhead and other developer services were present; CPU was not pinned. Goroutine medians returned to their observed baseline, but heap/working set did not; no forced GC or memory-baseline acceptance is claimed. Database activity sampling is not a replacement for query-count and pool-wait measurements.

## Message fan-out accounting contracts

`fanout-observer.mjs` is a portable Node/k6 receiver-accounting component for the next message fan-out profile. It accepts only the selected channel/probe, checks each authoritative actor against the payload sender, and requires every sender/sequence slot exactly once with unique message IDs. Missing, duplicate or matching malformed deliveries prevent completeness; late duplicates invalidate earlier complete snapshots. Reordering is counted separately. State is bounded to 1,000 senders and 10,000 expected messages per receiver. Sparse sender lists are rejected before any network work.

Run all load-test contracts with `node --experimental-vm-modules --test loadtest/*.test.mjs`. The observer was also executed in k6 v2.4.0 with two offline checks. The optional producer described below now adds message traffic to `ws_connect.js`. A real shared-guild fixture and HTTP/WebSocket/history reconciliation remain a separate acceptance gate. No actual fan-out capacity result is claimed by these unit/runtime contracts.

The observer is the strict, fault-free load-profile criterion. It does not promise exactly-once transport under reconnect, outbox retry or process failure; those scenarios require separate replay/idempotency acceptance.


## Optional local message producer

`ws_connect.js` now enables message publishing when any nonempty `FANOUT_*` setting is supplied. Configure all of `FANOUT_SERVER_ID`, `FANOUT_CHANNEL_ID`, `FANOUT_PROBE_ID`, and `FANOUT_USER_IDS` (a JSON array in the same order as the seeded username suffixes). The base URL must be loopback and `USER_COUNT == WS_VUS == userIds.length`. Every account must already belong to the selected disposable plaintext channel with read/send access. Do not use a real user channel.

Defaults are five messages per sender, a 20-second delay after each socket opens, and 2,000 milliseconds between messages. Override with `FANOUT_MESSAGES_PER_SENDER`, `FANOUT_START_DELAY_SECONDS`, and `FANOUT_MESSAGE_INTERVAL_MS`. The start delay must exceed the ramp duration by five seconds; the final scheduled send must precede socket closure by five seconds. This is a bounded fault-free profile: duplicate delivery fails this benchmark, without asserting exactly-once delivery across reconnects or crashes.

HTTP responses must be 201 with the correct authoritative actor, channel and message ID. Each receiver must see every expected sender/sequence pair once. Aggregate counters require all sends, all deliveries and all receivers; zero duplicates and malformed matching events are mandatory. Each `FANOUT_RECEIPT` log contains a SHA-256 digest of canonical sender/sequence/message-ID tuples and the sender's HTTP acknowledgement IDs. A surrounding fixture must still compare these digests against persisted HTTP history. The bounded November16 run below completes this comparison. Passing mocked contracts or `k6 inspect` alone does not establish end-to-end fan-out acceptance.

Run all contracts with `node --experimental-vm-modules --test loadtest/*.test.mjs`. These cover the producer, receiver, script wiring, history reconciliation and profile lifecycle. k6 v2.4.0 successfully evaluates the enabled profile with `k6 inspect` and explicit synthetic `-e` settings; inspect performs no network workload.


The recorded plaintext message profile used 20 ordinary users joined through the real invite API, 5 messages each and 75-second sockets. It passed 240 checks: 100 accepted messages, 2,000 unique deliveries, 20 complete receivers, zero duplicate/invalid deliveries. All receiver digests matched the 100-message HTTP history; both pagination flags were false. All six recovery samples had zero read/write pumps. Backend88892ed1 is unchanged through load fix a03ea5d4. The initial actual run caught the wrong mocked envelope (`data` instead of Go's `d`); fail-first regression and corrected results are recorded in `implementation/verification/refactor-fanout-20-session-profile-2026-11-16.json`. This is bounded correctness/resource evidence; capacity, slow-consumer, query/pool-wait and long-soak acceptance remain open.


`fanout-history.mjs` supplies asynchronous, bounded reconciliation for PostgreSQL profiles. Inject authenticated `fetchPage({before, limit})` returning the existing MessagePage envelope. REST pages are ascending; the first row is the oldest cursor for the next request. The default order is PostgreSQL's positive, safe `source_sequence`, matching `postgresMessageRepo`; concurrent transaction timestamps may move backward. For SQLite history, pass the explicit sixth argument `"created_at_id"`: RFC3339 timestamps retain nanosecond precision and normalize offsets, with ID ties checked. Unknown orders and missing/invalid PostgreSQL positions fail; there is no automatic timestamp fallback. Both modes reject page overlap, duplicate/foreign/malformed messages and unexpected pagination, then compare every receiver digest and HTTP acknowledgement with persisted IDs. Receiver-only success cannot prove persistence. The helper does not log in or grant permissions.

Client message IDs are SHA-256 digests of the probe, sender and sequence tuple. This preserves repeatable retry IDs while respecting the server's 128-character limit even at the profile's maximum identifier lengths. A fail-first regression covers that limit. The original 75-second runtime receipt remains bound to its historical load commit; it does not retrospectively validate later producer changes.


## Profile failure reporting

Node-based fixture runners can use `runProfileWithReport` from `profile-lifecycle.mjs` to run the workload, join owned-resource cleanup, and then persist the report. Supply `run`, `cleanup`, `writeReport`, and a mutable `report` object. A single failure keeps its original identity; multiple failures are thrown together as `AggregateError.errors` in workload/cleanup/report order. The report records phase names rather than exception contents. A report-write failure still rejects the run, including after successful traffic.

The caller must verify resource ownership, attempt and join each cleanup operation even if another fails, and provide sufficient disk space before starting. This helper does not manage processes, databases, permissions, disk capacity or retries. Six lifecycle contracts include the historical ENOSPC masking pattern as a negative control. They do not establish that the interrupted 5,800-message profile completed. Subsequent isolated runs completed the 5,800-message workload and independently matched all 116,000 healthy deliveries, 58 HTTP history pages, 20 receiver digests and 5,800 sender acknowledgement IDs. See `implementation/verification/refactor-fanout-5800-complete-profile-2026-11-16.json` and `refactor-fanout-integrated-5800-profile-2026-11-16.json` for their exact source revisions and resource observations. Those bounded runs do not establish capacity, natural slow-consumer isolation or long-soak acceptance.

For a non-reading local peer, see [slow-consumer/README.md](slow-consumer/README.md). That helper keeps the server reader live using unsolicited pongs and application heartbeats without draining output; its contract tests are separate from a real server/PostgreSQL workload.

The bounded natural TCP profile on `dda2c221` subsequently ran twenty healthy users alongside one non-reading peer. It observed 21→20 server pump pairs while all healthy sockets completed, independently reconciled all 5,800 messages/116,000 deliveries, and recovered to zero pumps. See `implementation/verification/refactor-natural-slow-consumer-profile-2026-11-16.json` for source hashes, timing, cleanup and limitations. The fixture did not instrument whether send-queue overflow or the existing write deadline removed the slow peer. This single run does not establish capacity, repeatability variance, churn or long-soak acceptance.
