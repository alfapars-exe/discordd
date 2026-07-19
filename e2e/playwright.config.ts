/**
 * Playwright config for the HiChat! E2E suite.
 *
 * Stack under test:
 *   1. The real Go backend, built with CGO_ENABLED=0 into e2e/.tmp/ and run
 *      against a fresh SQLite file per run (see scripts/start-server.mjs).
 *   2. The Vite dev server, which already proxies /api and /ws to :9090
 *      (client/vite.config.ts). No production client build is needed, which
 *      keeps both local runs and CI fast.
 *
 * Both are declared as `webServer` entries so Playwright owns their lifecycle
 * and tears them down even when the run fails.
 *
 * Ports are fixed rather than random because client/vite.config.ts hardcodes
 * `strictPort: true` on 3030 and the dev proxy target `localhost:9090`.
 * Overriding either would mean editing production source.
 *
 * baseURL uses `localhost` deliberately: the hichat_media attachment cookie is
 * set with Secure + SameSite=None (server/handlers/auth.go), and Chromium only
 * accepts Secure cookies from a trustworthy origin. http://localhost qualifies;
 * a LAN IP would not, and every image assertion would fail as a 401.
 *
 * Local run (from repo root):
 *   cd e2e && npm ci && npx playwright install chromium && npm test
 */

import { defineConfig, devices } from "@playwright/test";
import { join } from "node:path";

const CLIENT_PORT = 3030;
const SERVER_PORT = 9090;
const BASE_URL = `http://localhost:${CLIENT_PORT}`;

/**
 * Credentials for the single account the run shares, written by
 * tests/auth.setup.ts and read by helpers.ts's loginAsTestUser().
 *
 * Deliberately NOT a Playwright storageState file. The session is carried by
 * the HttpOnly hichat_refresh cookie (the access token is never mirrored into
 * localStorage), and authService.RefreshToken rotates that cookie, invalidating
 * the previous value server-side. A shared storageState therefore works for
 * exactly one spec and then bounces every later context to /login. Logging in
 * per test is both correct and cheap — handlers/auth.go resets the login rate
 * limiter on success, so successful logins never accumulate toward the cap.
 */
export const ACCOUNT_FILE = join(__dirname, ".tmp", "account.json");

export default defineConfig({
  testDir: "./tests",
  outputDir: "./test-results",

  // The suite shares one backend, one account and one server/channel, so
  // parallelism across files would interleave writes to the same message
  // stream. Single worker keeps assertions deterministic.
  fullyParallel: false,
  workers: 1,

  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["list"], ["html", { open: "never" }]] : [["list"], ["html", { open: "never" }]],

  timeout: 60_000,
  expect: { timeout: 15_000 },

  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    navigationTimeout: 30_000,
    actionTimeout: 15_000,
  },

  projects: [
    {
      // Registers the one account the whole run shares. Split out as its own
      // project because POST /api/auth/register is rate limited to 3 per 10
      // minutes per IP (server/init_services.go) — a per-test registration
      // would 429 the suite on the fourth test, and again on any retry.
      name: "setup",
      testMatch: /auth\.setup\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "chromium",
      testIgnore: /auth\.setup\.ts/,
      dependencies: ["setup"],
      use: { ...devices["Desktop Chrome"] },
    },
  ],

  webServer: [
    {
      command: "node ./scripts/start-server.mjs",
      cwd: __dirname,
      url: `http://127.0.0.1:${SERVER_PORT}/api/health`,
      // Generous: a cold `go build` on a clean module cache dominates this.
      timeout: 300_000,
      // Never adopt a developer's running dev server — it would be pointed at
      // their real database rather than the throwaway one.
      reuseExistingServer: false,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      command: "npm run dev",
      cwd: join(__dirname, "..", "client"),
      url: BASE_URL,
      // Vite's first cold dep-optimize pass on this client is slow.
      timeout: 180_000,
      reuseExistingServer: !process.env.CI,
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});
