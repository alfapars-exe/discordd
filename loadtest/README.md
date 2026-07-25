# WebSocket connect load test (k6)

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
| `PASSWORD`         | `loadtest-password`       | Password shared by all accounts used in the run. |
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
