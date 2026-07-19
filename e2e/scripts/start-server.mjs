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
 * e2e/.tmp/run-<timestamp>/, and the child's cwd is that directory so the Go
 * server's godotenv.Load() cannot pick up a developer's repo-root .env.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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

/** Keep the newest few run dirs for post-mortem; drop the rest. */
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
    // Windows can hold the .exe/.db handle briefly after a killed run; a
    // failed cleanup is cosmetic, so never let it abort the suite.
    try {
      rmSync(stale, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

function buildServer() {
  const binName = process.platform === "win32" ? "hichat-e2e.exe" : "hichat-e2e";
  const binPath = join(TMP_ROOT, "bin", binName);
  mkdirSync(dirname(binPath), { recursive: true });

  console.log(`[e2e-server] go build (CGO_ENABLED=0) -> ${binPath}`);
  const started = Date.now();
  const res = spawnSync("go", ["build", "-o", binPath, "."], {
    cwd: SERVER_DIR,
    stdio: "inherit",
    // CGO off is what excludes go-libsql and selects the pure-Go driver.
    env: { ...process.env, CGO_ENABLED: "0" },
  });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`[e2e-server] go build failed with exit code ${res.status}`);
  }
  console.log(`[e2e-server] build finished in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  return binPath;
}

function main() {
  pruneOldRuns();

  const runDir = join(TMP_ROOT, `run-${Date.now()}`);
  const uploadDir = join(runDir, "uploads");
  mkdirSync(uploadDir, { recursive: true });

  const binPath = buildServer();

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

  console.log(`[e2e-server] starting ${binPath} on http://${HOST}:${PORT}`);
  console.log(`[e2e-server] run dir: ${runDir}`);

  const child = spawn(binPath, [], { cwd: runDir, env, stdio: "inherit" });

  child.on("exit", (code, signal) => {
    console.log(`[e2e-server] exited (code=${code} signal=${signal})`);
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
  process.on("exit", stop);
}

main();
