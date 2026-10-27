/**
 * start-server.mjs — builds and runs the real Go backend for the E2E suite.
 *
 * Invoked by playwright.config.ts's first `webServer` entry. Playwright waits
 * on http://127.0.0.1:9090/api/health and tears this process down afterwards.
 *
 * Why no Docker: server/Dockerfile documents that with CGO_ENABLED=0 the
 * go-libsql import is excluded by build constraints and modernc.org/sqlite
 * (pure Go) supplies the driver for a local DATABASE_PATH. Verified — the
 * binary builds and runs natively on Windows and on ubuntu-latest, so the
 * developer and CI exercise the identical binary.
 *
 * Why port 9090 is not configurable: client/vite.config.ts hardcodes the dev
 * proxy target as http://localhost:9090 for /api and ws://localhost:9090 for
 * /ws. Changing that would mean editing production source, which this suite
 * deliberately does not do.
 *
 * Isolation: every run gets a brand-new SQLite file and uploads dir under
 * e2e/.tmp/<unique-run-id>/, and the child's cwd is that directory so the Go
 * server's godotenv.Load() cannot pick up a developer's repo-root .env.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, realpathSync, rmSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const E2E_DIR = resolve(HERE, "..");
const REPO_ROOT = resolve(E2E_DIR, "..");
const SERVER_DIR = join(REPO_ROOT, "server");
const TMP_ROOT = join(E2E_DIR, ".tmp");

const HOST = "127.0.0.1";
const PORT = process.env.E2E_SERVER_PORT ?? "9090";

/**
 * Fixed test credentials. JWT_SECRET must be >= 32 chars and ENCRYPTION_KEY
 * exactly 64 hex chars (32-byte AES-256 key) — server/config/config.go fails
 * boot on either being missing or too short. These are throwaway values for a
 * database that is created empty and deleted after the run.
 */
const JWT_SECRET = "hichat-playwright-e2e-secret-key-not-for-production-use";
// Exactly 64 hex chars. Boot rejects an odd-length string ("invalid hex key"),
// so keep this as an obviously-countable repeated nibble run.
const ENCRYPTION_KEY = "0123456789abcdef".repeat(4);

/** Keep the newest few completed run dirs for post-mortem; never remove a live run. */
function pruneOldRuns(keep = 3) {
  if (!existsSync(TMP_ROOT)) return;
  const runs = readdirSync(TMP_ROOT)
    .filter((name) => name.startsWith("run-"))
    .map((name) => join(TMP_ROOT, name))
    .filter((path) => {
      try {
        return statSync(path).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
  for (const stale of runs.slice(0, Math.max(0, runs.length - keep))) {
    const ownerPath = join(stale, "owner.json");
    let active = false;
    try {
      const owner = JSON.parse(readFileSync(ownerPath, "utf8"));
      if (Number.isSafeInteger(owner.pid) && owner.pid > 0) {
        try {
          process.kill(owner.pid, 0);
          active = true;
        } catch (error) {
          active = error?.code === "EPERM";
        }
      }
    } catch {
      /* Missing or malformed markers are stale; only known live owners are protected. */
    }
    if (active) continue;
    // Windows can hold the .exe/.db handle briefly after a killed run; a
    // failed cleanup is cosmetic, so never let it abort the suite.
    try {
      rmSync(stale, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

/**
 * Absolute path to the Go toolchain when we can determine one.
 *
 * Resolving beats a bare "go" lookup: PATH is per-shell and writable, so a
 * stale or shadowing entry earlier on it decides which compiler builds the
 * binary under test. GOROOT is set by actions/setup-go on CI and by most
 * local installs; when it isn't, fall back to the PATH lookup rather than
 * guessing at install locations, since a wrong absolute path fails harder
 * and less legibly than no path at all.
 */
function resolveGo() {
  const goroot = process.env.GOROOT;
  if (goroot) {
    const candidate = join(goroot, "bin", process.platform === "win32" ? "go.exe" : "go");
    if (existsSync(candidate)) return candidate;
  }
  return "go";
}

function buildServer(runDir) {
  const binName = process.platform === "win32" ? "hichat-e2e.exe" : "hichat-e2e";
  const probeName = process.platform === "win32" ? "hichat-e2e-queue-probe.exe" : "hichat-e2e-queue-probe";
  const realTmpRoot = realpathSync(TMP_ROOT);
  const realRunDir = realpathSync(runDir);
  const runRelative = relative(realTmpRoot, realRunDir);
  if (!runRelative || runRelative === ".." || runRelative.startsWith(`..${sep}`)) {
    throw new Error("[e2e-server] unique run directory escaped disposable root");
  }
  const runStat = lstatSync(runDir);
  if (!runStat.isDirectory() || runStat.isSymbolicLink()) {
    throw new Error("[e2e-server] unique run directory must be a real directory");
  }
  const binDir = join(runDir, "bin");
  mkdirSync(binDir);
  const binStat = lstatSync(binDir);
  if (!binStat.isDirectory() || binStat.isSymbolicLink()) {
    throw new Error("[e2e-server] binary output directory must be a real directory");
  }
  const realBinDir = realpathSync(binDir);
  const binRelative = relative(realRunDir, realBinDir);
  if (!binRelative || binRelative === ".." || binRelative.startsWith(`..${sep}`)) {
    throw new Error("[e2e-server] binary output directory escaped unique run directory");
  }
  const binPath = join(binDir, binName);
  const probePath = join(binDir, probeName);
  if (existsSync(binPath) || existsSync(probePath)) {
    throw new Error("[e2e-server] binary output path already exists");
  }

  const goBin = resolveGo();
  console.log(`[e2e-server] ${goBin} build (CGO_ENABLED=0) -> ${binPath}`);
  const started = Date.now();
  const res = spawnSync(goBin, ["build", "-o", binPath, "."], {
    cwd: SERVER_DIR,
    stdio: "inherit",
    // CGO off is what excludes go-libsql and selects the pure-Go driver.
    env: { ...process.env, CGO_ENABLED: "0" },
  });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`[e2e-server] go build failed with exit code ${res.status}`);
  }
  const builtBin = lstatSync(binPath);
  if (!builtBin.isFile() || builtBin.isSymbolicLink() || dirname(realpathSync(binPath)) !== realBinDir) {
    throw new Error("[e2e-server] server binary was not created inside the owned run directory");
  }
  const probe = spawnSync(goBin, ["build", "-o", probePath, join(E2E_DIR, "scripts", "queue-probe.go")], {
    cwd: SERVER_DIR,
    stdio: "inherit",
    env: { ...process.env, CGO_ENABLED: "0" },
  });
  if (probe.error) throw probe.error;
  if (probe.status !== 0) throw new Error(`[e2e-server] queue probe build failed with exit code ${probe.status}`);
  const builtProbe = lstatSync(probePath);
  if (!builtProbe.isFile() || builtProbe.isSymbolicLink() || dirname(realpathSync(probePath)) !== realBinDir) {
    throw new Error("[e2e-server] queue probe was not created inside the owned run directory");
  }
  console.log(`[e2e-server] build finished in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  return binPath;
}

function main() {
  mkdirSync(TMP_ROOT, { recursive: true });
  const tmpStat = lstatSync(TMP_ROOT);
  if (!tmpStat.isDirectory() || tmpStat.isSymbolicLink()) {
    throw new Error("[e2e-server] disposable root must be a real directory");
  }
  pruneOldRuns();

  const runId = process.env.HICHAT_E2E_RUN_ID ?? "";
  if (!/^run-\d+-\d+-[a-f0-9]{16}$/.test(runId)) {
    throw new Error("[e2e-server] Playwright must provide a unique HICHAT_E2E_RUN_ID");
  }
  const runDir = join(TMP_ROOT, runId);
  const uploadDir = join(runDir, "uploads");
  mkdirSync(runDir);
  mkdirSync(uploadDir);

  const binPath = buildServer(runDir);
  const ownerPath = join(runDir, "owner.json");
  writeFileSync(ownerPath, JSON.stringify({ pid: process.pid }), { mode: 0o600 });

  const env = {
    ...process.env,
    SERVER_HOST: HOST,
    SERVER_PORT: PORT,
    DATABASE_PATH: join(runDir, "hichat-e2e.db"),
    // config.go prefers DATABASE_URL over DATABASE_PATH via firstNonEmpty.
    // Blank it explicitly so a developer's exported Turso DSN can never
    // point this run at the production database.
    DATABASE_URL: "",
    UPLOAD_DIR: uploadDir,
    // Keep data-export ZIPs inside this exact disposable run, beside uploads.
    // The repository stores private archives under DATA_EXPORT_DIR; leaving
    // its default relative path would still be run-local only because cwd is
    // runDir, but pinning it prevents a future cwd change from writing into
    // workspace data.
    DATA_EXPORT_DIR: join(runDir, "exports"),
    JWT_SECRET,
    ENCRYPTION_KEY,
    // HF_TOKEN empty => BackupConfig.Enabled=false, so no bucket sync runs.
    HF_TOKEN: "",
    // Voice is out of scope; leave LiveKit unconfigured.
    LIVEKIT_URL: "",
    LIVEKIT_API_KEY: "",
    LIVEKIT_API_SECRET: "",
    // Optional integrations off — each is disabled by an empty value.
    SENTRY_DSN: "",
    RESEND_API_KEY: "",
    KLIPY_API_KEY: "",
    ENVIRONMENT: "development",
    // warn, not info: the access-log middleware writes a line per HTTP
    // request, and a 5-test run makes several hundred. That buries a real
    // boot failure (a malformed ENCRYPTION_KEY, say) in scrollback, which is
    // the one message anyone reads these logs for. Set E2E_LOG_LEVEL=info to
    // get the request trace back when debugging a specific failure.
    LOG_LEVEL: process.env.E2E_LOG_LEVEL ?? "warn",
    LOG_FORMAT: "text",
  };
  // These variables enable hosted-space integrations/probes. A local fixture
  // must not inherit them from an IDE or user shell.
  delete env.SPACE_ID;
  delete env.SDK_SPACE;

  console.log(`[e2e-server] starting ${binPath} on http://${HOST}:${PORT}`);
  console.log(`[e2e-server] run dir: ${runDir}`);

  const child = spawn(binPath, [], { cwd: runDir, env, stdio: "inherit" });

  child.on("exit", (code, signal) => {
    console.log(`[e2e-server] exited (code=${code} signal=${signal})`);
    rmSync(ownerPath, { force: true });
    process.exit(code ?? 1);
  });
  child.on("error", (err) => {
    console.error(`[e2e-server] spawn failed: ${err.message}`);
    process.exit(1);
  });

  // Playwright kills this wrapper (process tree on Windows, group on POSIX).
  // Forwarding keeps the Go process from outliving the run when it doesn't.
  const stop = () => {
    if (!child.killed) child.kill();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  process.on("exit", () => {
    stop();
    rmSync(ownerPath, { force: true });
  });
}

main();
