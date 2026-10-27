/**
 * auth.setup.ts — registers the one account the run shares, and proves the
 * register → login flow works end to end.
 *
 * Why registration is hoisted into a setup project instead of living inside
 * golden-path.spec.ts: POST /api/auth/register is rate limited to 3 attempts
 * per 10 minutes per IP (server/init_services.go:
 * `NewLoginRateLimiter(3, 10*time.Minute)`), and unlike the login limiter the
 * counter is NOT reset on success — handlers/auth.go bumps it before the
 * request body is even decoded. This setup registers the shared UI account and
 * one synthetic notification recipient (two registrations total), leaving one
 * registration attempt available for an isolated retry.
 *
 * What this hands off is the *credentials*, not a session. See ACCOUNT_FILE in
 * playwright.config.ts for why a Playwright storageState snapshot cannot work
 * against a rotating refresh-token cookie.
 */

import { test as setup, expect } from "@playwright/test";
import { existsSync } from "node:fs";
import { ACCOUNT_FILE, CHANNEL_NOTIFICATION_FIXTURE_FILE } from "../playwright.config";
import {
  dismissOnboardingOverlays,
  expectSignedInShell,
  forceEnglish,
  generateTestPassword,
  loginAsCredentials,
  provisionChannelNotificationFixture,
  resetChannelNotificationFixture,
  uniqueUsername,
  writeTestAccount,
  readTestAccount,
} from "./helpers";

setup("register a fresh account, then log back in", async ({ page }) => {
  const isRetry = existsSync(ACCOUNT_FILE);
  const account = isRetry ? readTestAccount() : { username: uniqueUsername(), password: generateTestPassword() };
  const { username, password } = account;
  await forceEnglish(page);

  if (isRetry) {
    // Credentials are persisted before the first registration request. On a
    // setup retry, authenticate the same account; only register it if that
    // first attempt failed before the account was created. This avoids
    // burning the per-IP registration limit with duplicate submissions.
    // The recovery fetches below are relative to the current page origin.
    await page.goto("/login");
    const status = await page.evaluate(async (candidate) => {
      const login = await fetch("/api/auth/login", {
        method: "POST",
        credentials: "omit",
        headers: { "Content-Type": "application/json", "X-HiChat-Client": "web" },
        body: JSON.stringify(candidate),
      });
      if (login.status !== 401) return login.status;
      const register = await fetch("/api/auth/register", {
        method: "POST",
        credentials: "omit",
        headers: { "Content-Type": "application/json", "X-HiChat-Client": "web" },
        body: JSON.stringify({ ...candidate, display_name: candidate.username, email: `${candidate.username}@example.test` }),
      });
      return register.status;
    }, account);
    if (status < 200 || status >= 300) throw new Error(`setup account recovery failed (${status})`);
    await loginAsCredentials(page, account);
    if (existsSync(CHANNEL_NOTIFICATION_FIXTURE_FILE)) {
      await resetChannelNotificationFixture(page);
    } else {
      await provisionChannelNotificationFixture(page, account);
    }
    return;
  }

  // Persist generated credentials before network requests so a Playwright
  // retry can safely reuse them if registration succeeds but a later UI step
  // fails. They live only under ignored e2e/.tmp and are removed at teardown.
  writeTestAccount(account);

  // ─── Register ──────────────────────────────────────────────────────────
  await page.goto("/register");

  await page.getByLabel(/^Username/i).fill(username);
  // "Password" is a prefix of "Confirm Password"; anchor so the two fields
  // stay unambiguous.
  await page.getByLabel(/^Password/i).fill(password);
  await page.getByLabel(/^Confirm Password/i).fill(password);
  // New registrations require an email. Existing email-less accounts remain
  // supported by the login contract; they are not created by this fresh run.
  await page.getByLabel(/^Email/i).fill(`${username}@example.test`);

  // The submit button is disabled until the ToS checkbox is ticked.
  await page.getByRole("checkbox").check();
  // auth.json maps the "register" key to the label "Continue".
  await page.getByRole("button", { name: /^Continue$/ }).click();

  await expect(page).toHaveURL(/\/channels/, { timeout: 20_000 });
  await expectSignedInShell(page);

  // Clear the one-time overlays. Both dismissals persist server-side
  // (has_seen_welcome / has_seen_download_prompt), so no later test sees them.
  await dismissOnboardingOverlays(page);

  // ─── Log out, then log back in ─────────────────────────────────────────
  // Proves the credentials were really persisted rather than the session being
  // a register side effect, and exercises the login form before any spec
  // depends on it.
  await page.evaluate(() => globalThis.localStorage.clear());
  await page.context().clearCookies();

  await forceEnglish(page);
  await page.goto("/login");
  await page.getByLabel(/^Username/i).fill(username);
  await page.getByLabel(/^Password/i).fill(password);
  await page.getByRole("button", { name: /^Log In$/ }).click();

  await expect(page).toHaveURL(/\/channels/, { timeout: 20_000 });
  await expectSignedInShell(page);

  if (existsSync(CHANNEL_NOTIFICATION_FIXTURE_FILE)) {
    await resetChannelNotificationFixture(page);
  } else {
    await provisionChannelNotificationFixture(page, account);
  }
});
