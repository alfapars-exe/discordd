import { runProfileWithReport } from "./profile-lifecycle.mjs";
import { readFileSync, writeFileSync, mkdirSync, statfsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { requestLocalAPI } from "./local-profile-api.mjs";
import { reconcileFanoutHistory } from "./fanout-history.mjs";
import { collectRuntimeTelemetry, RUNTIME_TELEMETRY_QUERY } from "./profile-telemetry.mjs";
import { readLocalConfig, spawnOwned, validateLocalFixture, snapshotSources, assertSnapshotUnchanged, joinOwnedProcesses, openProfileLog, finishProfileLog, captureProbeResult } from "./local-profile-fixture.mjs";
const cfg = readLocalConfig(process.argv[2]);
validateLocalFixture(cfg);
const sourceSnapshot = snapshotSources(cfg.source);
const runId = `run-${Date.now()}-${process.pid}-${randomBytes(8).toString("hex")}`;
const runDir = join(cfg.tempDir, runId);
mkdirSync(runDir);
const source = cfg.source,
  go = cfg.goBinary;
const serverBin = join(runDir, "hichat-capacity.exe"),
  fixtureBin = join(runDir, "pg-fixture.exe");
const fixtureEnv = {
  ...process.env,
  HICHAT_E2E_POSTGRES_DSN: cfg.controlDSN,
  HICHAT_PG_CA_PEM: "",
  HICHAT_PG_CERT_PEM: "",
  HICHAT_PG_KEY_PEM: ""
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function assertDiskHeadroom(starting = false) {
  for (const [volume, min] of [[process.env.SystemDrive + "/", starting ? 1024 ** 3 : 512 * 1024 ** 2], [cfg.tempDir, starting ? 4 * 1024 ** 3 : 1024 ** 3]]) {
    const stats = statfsSync(volume),
      free = stats.bavail * stats.bsize;
    if (free < min) throw new Error(`Insufficient owned profile disk headroom: ${volume} free=${free} required=${min}`);
  }
}
function sql(query, db = "hichat_e2e_control") {
  return executeSQL(query, db);
}
function executeSQL(query, db, options = {}) {
  return execFileSync(cfg.dockerBinary, ["exec", "-i", "--env", "PGAPPNAME=hichat-local-profile-collector", cfg.container, "psql", "-U", "hichat_tls_test", "-d", db, "-v", "ON_ERROR_STOP=1", "-tA"], {
    ...options,
    input: query,
    encoding: "utf8",
    windowsHide: true
  }).trim();
}
let server,
  load,
  slow,
  slowExit,
  slowDone = false,
  slowEvents = [],
  slowError = false,
  slowPeakAt,
  slowRetiredAt,
  slowHealthySamples = 0,
  created = false,
  adminToken = "",
  stopRequested = false;
const interrupt = () => {
  stopRequested = true;
  load?.kill();
  slow?.kill();
  server?.kill();
};
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
let logWriteFailed = false;
const pendingLogs = new Set();
function profileLog(path) {
  const log = openProfileLog(path, () => {
    logWriteFailed = true;
    interrupt();
  });
  pendingLogs.add(log);
  return log;
}
async function flushLog(log) {
  try {
    await finishProfileLog(log);
  } finally {
    pendingLogs.delete(log);
  }
}
let samples = [],
  summary;
const report = {
  evidenceVersion: 2,
  sourceCommit: cfg.sourceCommit,
  loadCommit: cfg.sourceCommit,
  sourceSnapshot,
  profile: {
    vus: 20,
    users: 21,
    slowPeers: 1,
    rampUp: "10s",
    hold: "605s",
    rampDown: "10s",
    holdSeconds: 620,
    legacyToken: false
  },
  samples
};
const metricsPs = join(runDir, "process-metrics.ps1");
writeFileSync(metricsPs, `param([int]$TaskServerPid)
$p=Get-Process -Id $TaskServerPid -ErrorAction Stop
$p | Select-Object Id,ProcessName,CPU,WorkingSet64,PrivateMemorySize64 | ConvertTo-Json -Compress
`);
const ps = join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe");
let baseURL, dbName;
function request(path, body, token, method) {
  return requestLocalAPI(baseURL, {
    path,
    body,
    token,
    method
  });
}
async function debug(path) {
  const response = await fetch(baseURL + "/debug/pprof/" + path, {
    headers: {
      Authorization: `Bearer ${adminToken}`
    },
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error(`Admin profiling failed status=${response.status}`);
  return response.text();
}
async function sample(phase) {
  assertDiskHeadroom();
  if (server.exitCode !== null) throw new Error("Owned server exited before sample");
  const goroutines = await debug("goroutine?debug=1"),
    heap = await debug("heap?debug=1");
  const total = Number(goroutines.match(/goroutine profile: total (\d+)/)?.[1]);
  if (!Number.isSafeInteger(total)) throw new Error("Missing goroutine profile count");
  const pumps = {
    read: 0,
    write: 0
  };
  for (const block of goroutines.split(/\r?\n\r?\n/)) {
    const count = Number(block.match(/^(\d+) @/m)?.[1] ?? 0);
    if (block.includes("ws.(*Client).ReadPump")) pumps.read += count;
    if (block.includes("ws.(*Client).WritePump")) pumps.write += count;
  }
  const memory = {};
  for (const key of ["HeapAlloc", "HeapInuse", "NumGC"]) {
    const value = heap.match(new RegExp("^# " + key + " = (\\d+)", "m"));
    if (!value) throw new Error(`Missing heap profile field ${key}`);
    memory[key] = Number(value[1]);
  }
  const stack = heap.match(/^# Stack = (\d+) \/ (\d+)/m);
  if (!stack) throw new Error("Missing Go stack profile values");
  memory.StackInuse = Number(stack[1]);
  memory.StackSys = Number(stack[2]);
  const os = JSON.parse(execFileSync(ps, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", metricsPs, "-TaskServerPid", String(server.pid)], {
    encoding: "utf8",
    windowsHide: true
  }));
  const database = JSON.parse(sql(`SELECT json_build_object('connections',count(*),'active',count(*) FILTER(WHERE state='active'),'lockWaits',count(*) FILTER(WHERE wait_event_type='Lock'),'idleInTransaction',count(*) FILTER(WHERE state='idle in transaction'),'tlsConnections',count(*) FILTER(WHERE ssl),'clientCertificates',count(*) FILTER(WHERE client_dn IS NOT NULL)) FROM pg_stat_activity a JOIN pg_stat_ssl s ON a.pid=s.pid WHERE datname='${dbName}' AND backend_type='client backend' AND application_name='hichat';`));
  if (!Number.isSafeInteger(database.connections) || database.connections < 1 || database.connections !== database.tlsConnections || database.connections !== database.clientCertificates) {
    report.rejectedDatabaseSample = {
      at: new Date().toISOString(),
      database
    };
    throw new Error("Application database connection lacks mTLS");
  }
  const value = {
    at: new Date().toISOString(),
    phase,
    goroutines: total,
    pumps,
    memory,
    os,
    database
  };
  samples.push(value);
  writeFileSync(join(cfg.tempDir, "capacity-samples.json"), JSON.stringify(samples, null, 2));
  return value;
}
async function prepareProfileBackend() {
  assertDiskHeadroom(true);
  console.log(JSON.stringify({
    phase: "build",
    source: report.sourceCommit
  }));
  report.go = execFileSync(go, ["version"], {
    encoding: "utf8",
    windowsHide: true
  }).trim();
  report.k6 = execFileSync(cfg.k6, ["version"], {
    encoding: "utf8",
    windowsHide: true
  }).trim();
  execFileSync(go, ["build", "-mod=readonly", "-o", serverBin, "."], {
    cwd: join(source, "server"),
    env: {
      ...process.env,
      CGO_ENABLED: "0"
    },
    windowsHide: true
  });
  execFileSync(go, ["build", "-mod=readonly", "-o", fixtureBin, join(source, "e2e/scripts/pg-fixture.go")], {
    cwd: join(source, "server"),
    env: {
      ...process.env,
      CGO_ENABLED: "0"
    },
    windowsHide: true
  });
  execFileSync(fixtureBin, ["create", runDir, runId], {
    env: fixtureEnv,
    windowsHide: true
  });
  created = true;
  const descriptor = JSON.parse(readFileSync(join(runDir, "hichat-e2e-postgres.json"), "utf8"));
  dbName = new URL(descriptor.url).pathname.slice(1);
  if (!/^hichat_e2e_run_[0-9_]+_[a-f0-9]{16}$/.test(dbName)) throw new Error("Invalid owned database identity");
  const listener = createServer();
  await new Promise(resolve => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  baseURL = `http://127.0.0.1:${port}`;
  const env = {};
  for (const key of ["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "ProgramData", "COMSPEC", "PATHEXT"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  Object.assign(env, {
    SERVER_HOST: "127.0.0.1",
    SERVER_PORT: String(port),
    DATABASE_PATH: "",
    DATABASE_URL: descriptor.url,
    UPLOAD_DIR: join(runDir, "uploads"),
    DATA_EXPORT_DIR: join(runDir, "exports"),
    JWT_SECRET: randomBytes(48).toString("hex"),
    ENCRYPTION_KEY: randomBytes(32).toString("hex"),
    ENVIRONMENT: "development",
    LOG_LEVEL: "warn",
    LOG_FORMAT: "text",
    HICHAT_PPROF: "1"
  });
  mkdirSync(env.UPLOAD_DIR);
  const log = profileLog(join(cfg.tempDir, "capacity-server.log"));
  server = spawnOwned(serverBin, [], {
    cwd: runDir,
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  server.stdout.pipe(log, {
    end: false
  });
  server.stderr.pipe(log, {
    end: false
  });
  execFileSync(go, ["build", "-mod=readonly", "-o", join(runDir, "slow-consumer.exe"), join(source, "loadtest/slow-consumer/main.go")], {
    cwd: join(source, "server"),
    env: {
      ...process.env,
      CGO_ENABLED: "0"
    },
    windowsHide: true
  });
  const deadline = Date.now() + 180000;
  let ready = false;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error("Owned backend exited during startup");
    try {
      const res = await fetch(baseURL + "/api/ready", {
        signal: AbortSignal.timeout(1000)
      });
      if (res.ok) {
        ready = true;
        break;
      }
    } catch {}
    await sleep(500);
  }
  if (!ready) throw new Error("Owned backend readiness timed out");
}
async function seedProfileAccounts() {
  const seed = randomBytes(5).toString("hex"),
    prefix = `load${seed}`,
    monitor = `monitor${seed}`,
    password = `Aa1!${randomBytes(16).toString("hex")}`;
  await request("/api/auth/register", {
    username: monitor,
    password,
    email: `${monitor}@example.test`,
    display_name: "Synthetic Load Monitor"
  });
  const adminType = sql("SELECT data_type FROM information_schema.columns WHERE table_name='users' AND column_name='is_platform_admin';", dbName);
  sql(`UPDATE users SET is_platform_admin=${adminType === 'boolean' ? 'TRUE' : '1'} WHERE username='${monitor}';`, dbName);
  for (let i = 0; i < 21; i++) sql(`INSERT INTO users(id,username,display_name,password_hash,email) SELECT '${randomUUID()}','${prefix}${i}','Synthetic Load User',password_hash,'${prefix}${i}@example.test' FROM users WHERE username='${monitor}';`, dbName);
  const auth = await request("/api/auth/login", {
    username: monitor,
    password
  });
  adminToken = auth.access_token;
  if (typeof adminToken !== "string" || !adminToken) throw new Error("Missing monitor credential");
  report.dbUsers = Number(sql(`SELECT count(*) FROM users WHERE username LIKE '${prefix}%';`, dbName));
  if (report.dbUsers !== 21) throw new Error("Load account seeding count mismatch");
  return {
    seed,
    prefix,
    password
  };
}
async function createProfileChannel(seed) {
  const guild = await request("/api/servers", {
    name: `Fanout ${seed}`,
    host_type: "mqvi_hosted"
  }, adminToken);
  const updated = await request(`/api/servers/${guild.id}`, {
    e2ee_enabled: false
  }, adminToken, "PATCH");
  if (updated.e2ee_enabled !== false) throw new Error("Fixture channel must be plaintext");
  const channel = await request(`/api/servers/${guild.id}/channels`, {
    name: "fanout-probe",
    type: "text"
  }, adminToken);
  const invite = await request(`/api/servers/${guild.id}/invites`, {
    max_uses: 21,
    expires_in: 20
  }, adminToken);
  return {
    guild,
    channel,
    invite
  };
}
async function joinProfileAccounts(prefix, password, guild, channel, invite) {
  const userIds = [];
  let readerToken, slowToken;
  for (let i = 0; i < 21; i++) {
    const login = await request("/api/auth/login", {
      username: `${prefix}${i}`,
      password
    });
    const joined = await request("/api/servers/join", {
      invite_code: invite.code
    }, login.access_token);
    if (joined.id !== guild.id) throw new Error("Unexpected joined guild");
    const page = await request(`/api/servers/${guild.id}/channels/${channel.id}/messages?limit=100`, undefined, login.access_token);
    if (!Array.isArray(page.messages) || page.messages.length !== 0) throw new Error("Expected empty readable fixture channel");
    const uid = sql(`SELECT id FROM users WHERE username='${prefix}${i}';`, dbName);
    if (i === 20) {
      slowToken = login.access_token;
      report.slowUserId = uid;
    } else {
      userIds.push(uid);
      readerToken = login.access_token;
    }
  }
  return {
    userIds,
    readerToken,
    slowToken
  };
}
async function startSlowPeer(slowToken) {
  slow = spawnOwned(join(runDir, "slow-consumer.exe"), [], {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"]
  });
  let slowText = "",
    slowStderr = "";
  slow.stdout.on("data", chunk => {
    slowText += chunk.toString("utf8");
    if (slowText.length > 8192) {
      slowError = true;
      slow.kill();
    }
  });
  slow.stderr.on("data", chunk => {
    slowStderr += chunk.toString("utf8");
    if (slowStderr.length > 8192) {
      slowError = true;
      slow.kill();
    }
  });
  slowExit = new Promise(resolve => {
    slow.once("error", () => {
      slowError = true;
    });
    slow.once("close", code => {
      slowDone = true;
      const captured = captureProbeResult({
        exitCode: code,
        text: slowText,
        stderrPresent: slowStderr.length > 0,
        outputPath: join(cfg.tempDir, "slow-probe-events.json")
      });
      report.slow = captured.result;
      slowEvents = captured.result.events;
      slowError ||= captured.failed;
      resolve(code);
    });
  });
  slow.stdin.once("error", () => {
    slowError = true;
    slow.kill();
  });
  slow.stdin.end(JSON.stringify({
    base_url: baseURL,
    access_token: slowToken,
    hold_seconds: 750
  }));
  const admissionDeadline = Date.now() + 10000;
  let admitted = false;
  while (Date.now() < admissionDeadline) {
    if (slowDone) throw new Error("Slow probe exited before admission");
    const v = await sample("slow_admission");
    if (v.pumps.read === 1 && v.pumps.write === 1) {
      admitted = true;
      break;
    }
    await sleep(250);
  }
  if (!admitted) throw new Error("Slow peer was not admitted to server pumps");
}
async function runHealthyProfile(prefix, password, guild, channel, probeId, userIds) {
  console.log(JSON.stringify({
    phase: "load",
    vus: 20,
    slowPeers: 1,
    holdSeconds: 620
  }));
  const logLoad = profileLog(join(cfg.tempDir, "capacity-k6.log"));
  load = spawnOwned(cfg.k6, ["run", "--log-format", "raw", "--summary-export", join(cfg.tempDir, "capacity-k6-summary.json"), join(source, "loadtest/ws_connect.js")], {
    env: {
      ...process.env,
      BASE_URL: baseURL,
      USERNAME_PREFIX: prefix,
      USER_COUNT: "20",
      PASSWORD: password,
      WS_VUS: "20",
      RAMP_UP: "10s",
      HOLD: "605s",
      RAMP_DOWN: "10s",
      HOLD_SECONDS: "620",
      USE_LEGACY_TOKEN: "false",
      FANOUT_SERVER_ID: guild.id,
      FANOUT_CHANNEL_ID: channel.id,
      FANOUT_PROBE_ID: probeId,
      FANOUT_USER_IDS: JSON.stringify(userIds),
      FANOUT_MESSAGES_PER_SENDER: "290",
      FANOUT_START_DELAY_SECONDS: "20",
      FANOUT_MESSAGE_INTERVAL_MS: "2000"
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  load.stdout.pipe(logLoad, {
    end: false
  });
  load.stderr.pipe(logLoad, {
    end: false
  });
  let loadDone = false;
  const loadExit = new Promise((resolve, reject) => {
    load.once("error", () => {
      loadDone = true;
      resolve(null);
    });
    load.once("exit", code => {
      loadDone = true;
      resolve(code);
    });
  });
  while (!loadDone) {
    if (stopRequested) throw new Error("Diagnostic interrupted");
    const value = await sample("load");
    observeSlowPeer(value);
    assertSlowDuringLoad();
    if (samples.length % 10 === 0) console.log(JSON.stringify({
      phase: "sample",
      goroutines: value.goroutines,
      pumps: value.pumps
    }));
    await sleep(1500);
  }
  const exitCode = await loadExit;
  await new Promise(resolve => {
    load.once("close", resolve);
    if (load.exitCode !== null && load.stdout.readableEnded && load.stderr.readableEnded) resolve();
  });
  await flushLog(logLoad);
  return exitCode;
}
async function assertSlowRetired() {
  if (!slowDone) throw new Error("Slow peer was not retired while healthy workload was live");
  await slowExit;
  if (slowError) throw new Error("Slow probe output or report failed");
  if (!slowPeakAt || !slowRetiredAt || slowHealthySamples < 10) throw new Error("Missing 21-to-20 server pump isolation observations");
  const connected = slowEvents[0],
    finished = slowEvents[1];
  if (connected.event !== "connected" || finished.event !== "finished" || finished.keepalive_pairs < 2 || finished.elapsed_ms >= 750000 || finished.post_upgrade_reader !== false) throw new Error("Slow probe liveness contract failed");
  report.slow.isolation = {
    peakAt: slowPeakAt,
    retiredAt: slowRetiredAt,
    healthySamplesAfterProbeExit: slowHealthySamples,
    requestedReceiveBufferBytes: 1024
  };
  // A live authenticated HTTP read after retirement excludes account/session revocation.
}
async function verifyProfileHistory(exitCode, guild, channel, probeId, userIds, readerToken) {
  summary = JSON.parse(readFileSync(join(cfg.tempDir, "capacity-k6-summary.json"), "utf8"));
  const metric = name => summary.metrics[name]?.values ?? summary.metrics[name];
  const counter = name => metric(name)?.count;
  report.result = {
    exitCode,
    handshakes: counter("ws_handshakes_succeeded"),
    completed: counter("ws_sessions_succeeded"),
    heartbeatAcks: counter("heartbeat_acks_received"),
    checks: summary.root_group?.checks,
    connecting: metric("ws_connecting"),
    sessionDuration: metric("ws_session_duration")
  };
  if (exitCode !== 0 || report.result.handshakes !== 20 || report.result.completed !== 20 || report.result.heartbeatAcks !== 400) throw new Error("Authenticated load/heartbeat contract failed");
  const receipts = readFileSync(join(cfg.tempDir, "capacity-k6.log"), "utf8").split(/\r?\n/).filter(line => line.startsWith("FANOUT_RECEIPT ")).map(line => JSON.parse(line.slice(15)));
  report.fanout.observedCounters = {
    sent: counter("fanout_sent"),
    received: counter("fanout_received"),
    receivers: counter("fanout_receivers"),
    duplicates: counter("fanout_duplicates"),
    invalid: counter("fanout_invalid")
  };
  const historyDir = join(cfg.tempDir, "history-pages");
  mkdirSync(historyDir);
  let historyPage = 0;
  const history = await reconcileFanoutHistory({
    probeId,
    channelId: channel.id,
    userIds,
    messagesPerSender: 290
  }, async ({
    before,
    limit
  }) => {
    await sleep(150);
    const page = await request(`/api/servers/${guild.id}/channels/${channel.id}/messages?limit=${limit}${before ? `&before=${encodeURIComponent(before)}` : ""}`, undefined, readerToken);
    const audit = {
      before,
      limit,
      has_more: page.has_more,
      has_more_after: page.has_more_after,
      messages: page.messages.map(({
        id,
        channel_id,
        user_id,
        content,
        created_at,
        source_sequence
      }) => ({
        id,
        channel_id,
        user_id,
        content,
        created_at,
        source_sequence
      }))
    };
    writeFileSync(join(historyDir, `${++historyPage}.json`), JSON.stringify(audit));
    return page;
  }, receipts, value => createHash("sha256").update(value).digest("hex"));
  report.fanout.result = {
    sent: counter("fanout_sent"),
    received: counter("fanout_received"),
    receivers: counter("fanout_receivers"),
    duplicates: counter("fanout_duplicates"),
    invalid: counter("fanout_invalid"),
    ...history,
    receipts
  };
  if (report.fanout.result.sent !== 5800 || report.fanout.result.received !== 116000 || report.fanout.result.receivers !== 20 || report.fanout.result.duplicates !== 0 || report.fanout.result.invalid !== 0) throw new Error("Fanout aggregate counter mismatch");
}
async function verifyRecovery() {
  for (let i = 0; i < 6; i++) {
    await sample("recovery");
    await sleep(1500);
  }
  const recovery = samples.filter(x => x.phase === 'recovery'),
    loadSamples = samples.filter(x => x.phase === 'load');
  if (!loadSamples.some(x => x.pumps.read === 20 && x.pumps.write === 20)) throw new Error("Did not observe twenty concurrent server pump pairs");
  if (recovery.some(x => x.pumps.read !== 0 || x.pumps.write !== 0)) throw new Error("Socket pump resources survived completed sessions");
}
function observeSlowPeer(value) {
  if (value.pumps.read === 21 && value.pumps.write === 21 && !slowPeakAt) slowPeakAt = value.at;
  if (slowPeakAt && value.pumps.read === 20 && value.pumps.write === 20) {
    if (!slowRetiredAt) slowRetiredAt = value.at;
    if (slowDone) slowHealthySamples++;
  }
}
function assertSlowDuringLoad() {
  if (slowDone && (slowError || report.slow.exitCode !== 0 || slowEvents.length !== 2 || slowEvents[1].reason !== "write_failed")) throw new Error("Slow peer ended without a clean observed server-close write failure");
}
await runProfileWithReport({
  report,
  run: async () => {
    await prepareProfileBackend();
    const {
      seed,
      prefix,
      password
    } = await seedProfileAccounts();
    const {
      guild,
      channel,
      invite
    } = await createProfileChannel(seed);
    let {
      userIds,
      readerToken,
      slowToken
    } = await joinProfileAccounts(prefix, password, guild, channel, invite);
    const probeId = `probe-${seed}`;
    report.fanout = {
      guild: guild.id,
      channel: channel.id,
      userIds,
      probeId,
      messagesPerSender: 290
    };
    for (let i = 0; i < 3; i++) {
      await sample("baseline");
      await sleep(1000);
    }
    await startSlowPeer(slowToken);
    const exitCode = await runHealthyProfile(prefix, password, guild, channel, probeId, userIds);
    await assertSlowRetired();
    await request(`/api/servers/${guild.id}/channels/${channel.id}/messages?limit=1`, undefined, slowToken);
    slowToken = undefined;
    report.slow.readableAfterRetirement = true;
    await verifyProfileHistory(exitCode, guild, channel, probeId, userIds, readerToken);
    await verifyRecovery();
    await collectRuntimeTelemetry({ report,
      read: () => JSON.parse(executeSQL(RUNTIME_TELEMETRY_QUERY, dbName, { timeout: 10000, maxBuffer: 128 * 1024 })) });
    report.limits = ["One 20-session local profile, not capacity/SLA or long-soak acceptance", "5800 plaintext channel messages; one non-reading TCP peer, no media provider load", "Profiling and process/DB sampling overhead included; CPU not pinned; other developer Docker services remain running", "Twenty-one ordinary users join through the real invite API; twenty healthy k6 users and one non-reading Go peer; separate synthetic platform admin reads profiles", "Heap is observed without forced GC; idle pool/heap retention is not asserted to return byte-for-byte to baseline"];
    console.log(JSON.stringify({
      phase: "accepted",
      handshakes: 20,
      completed: 20,
      heartbeatAcks: 400,
      samples: samples.length
    }));
  },
  cleanup: async () => {
    report.cleanupStartedAt = new Date().toISOString();
    const errors = [];
    try {
      await joinOwnedProcesses([load, slow, server]);
    } catch (error) {
      errors.push(error);
    }
    const flushed = await Promise.allSettled([...pendingLogs].map(flushLog));
    errors.push(...flushed.filter(result => result.status === "rejected").map(result => result.reason));
    report.logWriteFailed = logWriteFailed;
    if (logWriteFailed) errors.push(new Error("Profile log write failed"));
    try {
      if (created) {
        execFileSync(fixtureBin, ["drop", runDir, runId], {
          env: fixtureEnv,
          windowsHide: true
        });
        report.databaseDropped = true;
      }
    } catch (error) {
      errors.push(error);
    }
    try {
      assertSnapshotUnchanged(sourceSnapshot, snapshotSources(source));
      report.sourceStable = true;
    } catch (error) {
      errors.push(error);
    }
    if (errors.length) throw new AggregateError(errors, "Owned resource cleanup failed");
  },
  writeReport: value => writeFileSync(join(cfg.tempDir, "capacity-report.json"), JSON.stringify(value, null, 2))
});
