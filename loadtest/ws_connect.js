// k6 load test: concurrent WebSocket connections against the HiChat /ws
// hot path (auth -> ticket -> connect -> heartbeat -> hold).
//
// LOCAL/DEV ONLY. See README.md in this directory before running this
// against anything. The default BASE_URL points at a local dev server —
// there is no production URL anywhere in this file, by design.
//
// Run with: k6 run loadtest/ws_connect.js
// Override any setting with -e NAME=value, e.g.:
//   k6 run -e WS_VUS=50 -e BASE_URL=http://localhost:9090 loadtest/ws_connect.js
//
// No secret VALUES are hardcoded here — credentials are read from env vars
// and default to obviously-fake local placeholders.
import http from 'k6/http';
import ws from 'k6/ws';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

// ─── Configuration (all overridable via -e or exported env vars) ───

// Base HTTP URL of the server under test. Defaults to a local dev server —
// never point this at the HF Space (production) deployment.
const BASE_URL = __ENV.BASE_URL || 'http://localhost:9090';

// Login credentials. When USER_COUNT > 1, each VU logs in as
// `${USERNAME_PREFIX}${vuIndex}` (all sharing PASSWORD) instead of the
// single USERNAME — see README.md for why a real multi-VU run needs more
// than one seeded account.
const USERNAME = __ENV.USERNAME || 'loadtest';
const USERNAME_PREFIX = __ENV.USERNAME_PREFIX || 'loadtest';
// No default: a load test that authenticates with a password baked into the
// repo is one copy-paste away from being pointed at something real with a
// credential everyone can read. Fail fast instead.
const PASSWORD = __ENV.PASSWORD;
const USER_COUNT = parseInt(__ENV.USER_COUNT || '1', 10);

if (!PASSWORD) {
  throw new Error(
    'PASSWORD is required — pass it with `-e PASSWORD=<password>` or export it. See loadtest/README.md.'
  );
}

// When "true", skip the /api/auth/ws-ticket exchange entirely and open the
// WebSocket with the legacy `?token=<access_token>` query param instead.
// Bypasses the ws-ticket endpoint's per-IP rate limit and its tickets'
// single-use restriction, at the cost of requiring the target server to be
// started with HICHAT_ALLOW_LEGACY_WS_TOKEN=1 (dev/local only — see
// ws/handler.go). Every legacy-path connection is also audit-logged
// server-side regardless of this flag.
const USE_LEGACY_TOKEN = (__ENV.USE_LEGACY_TOKEN || 'false') === 'true';

// Scenario shape: ramp up to WS_VUS over RAMP_UP, hold for HOLD, ramp back
// down over RAMP_DOWN. Each VU opens exactly one WS connection and keeps it
// open for the HOLD_SECONDS below (must stay >= HOLD so the connection
// survives the whole hold window rather than closing early).
const WS_VUS = parseInt(__ENV.WS_VUS || '200', 10);
const RAMP_UP = __ENV.RAMP_UP || '30s';
const HOLD = __ENV.HOLD || '60s';
const RAMP_DOWN = __ENV.RAMP_DOWN || '20s';
const HOLD_SECONDS = parseInt(__ENV.HOLD_SECONDS || '90', 10);

// Client -> server heartbeat cadence. Matches the real client's interval;
// see ws/client.go pongWait (90s = 3 missed heartbeats at 30s each).
const HEARTBEAT_INTERVAL_MS = 30 * 1000;

const heartbeatAcks = new Counter('heartbeat_acks_received');

export const options = {
  scenarios: {
    ws_connections: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: RAMP_UP, target: WS_VUS },
        { duration: HOLD, target: WS_VUS },
        { duration: RAMP_DOWN, target: 0 },
      ],
      gracefulRampDown: '10s',
    },
  },
  thresholds: {
    // Every VU must reach a successful WS handshake — a single failure
    // means the auth/ticket/connect chain broke somewhere.
    checks: ['rate==1.0'],
    // Time to establish the WS connection (post-upgrade-request).
    ws_connecting: ['p(95)<1000'],
    // Sessions should survive close to the full hold window, not get
    // dropped early by a server-side slow-client disconnect.
    ws_session_duration: ['p(95)>' + (HOLD_SECONDS * 1000 * 0.9)],
  },
};

function wsURLFromBase(baseURL) {
  if (baseURL.startsWith('https://')) {
    return 'wss://' + baseURL.slice('https://'.length);
  }
  if (baseURL.startsWith('http://')) {
    // NOSONAR - ws:// mirrors an operator-supplied http:// base, which this
    // script only targets for local dev; an https:// base yields wss:// above.
    return 'ws://' + baseURL.slice('http://'.length);
  }
  return baseURL;
}

function usernameForVU() {
  if (USER_COUNT <= 1) {
    return USERNAME;
  }
  const idx = (__VU - 1) % USER_COUNT;
  return `${USERNAME_PREFIX}${idx}`;
}

// login exchanges username/password for an access token via
// POST /api/auth/login (handlers/auth.go AuthHandler.Login).
function login() {
  const res = http.post(
    `${BASE_URL}/api/auth/login`,
    JSON.stringify({ username: usernameForVU(), password: PASSWORD }),
    { headers: { 'Content-Type': 'application/json' } }
  );
  const ok = check(res, {
    'login succeeded': (r) => r.status === 200,
  });
  if (!ok) {
    return null;
  }
  return res.json('access_token');
}

// issueTicket exchanges the access token for a one-time WS connect ticket
// via POST /api/auth/ws-ticket (handlers/auth.go AuthHandler.WSTicket).
// Rate-limited per IP and the returned ticket is single-use — see
// README.md before scaling WS_VUS up against the ticket path.
function issueTicket(accessToken) {
  const res = http.post(
    `${BASE_URL}/api/auth/ws-ticket`,
    null,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const ok = check(res, {
    'ws-ticket issued': (r) => r.status === 200,
  });
  if (!ok) {
    return null;
  }
  return res.json('ticket');
}

export default function () {
  const accessToken = login();
  if (!accessToken) {
    return;
  }

  let wsURL;
  if (USE_LEGACY_TOKEN) {
    // Legacy path (see ws/handler.go HandleConnection): requires the
    // target server to run with HICHAT_ALLOW_LEGACY_WS_TOKEN=1.
    wsURL = `${wsURLFromBase(BASE_URL)}/ws?token=${accessToken}`;
  } else {
    const ticket = issueTicket(accessToken);
    if (!ticket) {
      return;
    }
    wsURL = `${wsURLFromBase(BASE_URL)}/ws?ticket=${ticket}`;
  }

  const res = ws.connect(wsURL, {}, function (socket) {
    socket.on('open', function () {
      socket.setInterval(function () {
        socket.send(JSON.stringify({ op: 'heartbeat' }));
      }, HEARTBEAT_INTERVAL_MS);
    });

    socket.on('message', function (data) {
      let msg;
      try {
        msg = JSON.parse(data);
      } catch (e) {
        return;
      }
      if (msg.op === 'heartbeat_ack') {
        heartbeatAcks.add(1);
      }
    });

    socket.on('error', function () {});

    // Hold the connection open for the configured window, then close it
    // ourselves so the VU can exit cleanly instead of being cut off by the
    // scenario's ramp-down.
    socket.setTimeout(function () {
      socket.close();
    }, HOLD_SECONDS * 1000);
  });

  check(res, { 'ws handshake succeeded (status 101)': (r) => r && r.status === 101 });
}
