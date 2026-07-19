/**
 * auth.setup.ts — registers the one account the run shares, and proves the
 * register → login flow works end to end.
 *
 * Why registration is hoisted into a setup project instead of living inside
 * golden-path.spec.ts: POST /api/auth/register is rate limited to 3 attempts
 * per 10 minutes per IP (server/init_services.go:
 * `NewLoginRateLimiter(3, 10*time.Minute)`), and unlike the login limiter the
 * counter is NOT reset on success — handlers/auth.go bumps it before the
 * request body is even decoded. One registration per test would 429 the fourth
 * test of the run, and a CI retry would 429 sooner. Registering exactly once
 * leaves plenty of headroom.
 *
 * What this hands off is the *credentials*, not a session. See ACCOUNT_FILE in
 * playwright.config.ts for why a Playwright storageState snapshot cannot work
 * against a rotating refresh-token cookie.
 */

import { test as setup, expect } from "@playwright/test";
import {
  TEST_PASSWORD,
  dismissOnboardingOverlays,
  forceEnglish,
  uniqueUsername,
  writeTestAccount,
} from "./helpers";

setup("register a fresh account, then log back in", async ({ page }) => {
  const username = uniqueUsername();
  await forceEnglish(page);

  // ─── Register ──────────────────────────────────────────────────────────
  await page.goto("/register");

  await page.getByLabel(/^Username/i).fill(username);
  // "Password" is a prefix of "Confirm Password"; anchor so the two fields
  // stay unambiguous.
  await page.getByLabel(/^Password/i).fill(TEST_PASSWORD);
  await page.getByLabel(/^Confirm Password/i).fill(TEST_PASSWORD);

  // The submit button is disabled until the ToS checkbox is ticked.
  await page.getByRole("checkbox").check();
  // auth.json maps the "register" key to the label "Continue".
  await page.getByRole("button", { name: /^Continue$/ }).click();

  await expect(page).toHaveURL(/\/channels/, { timeout: 20_000 });
  await expect(page.getByRole("button", { name: /Add Server/i })).toBeVisible({
    timeout: 20_000,
  });

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
  await page.getByLabel(/^Password/i).fill(TEST_PASSWORD);
  await page.getByRole("button", { name: /^Log In$/ }).click();

  await expect(page).toHaveURL(/\/channels/, { timeout: 20_000 });
  await expect(page.getByRole("button", { name: /Add Server/i })).toBeVisible({
    timeout: 20_000,
  });

  writeTestAccount({ username, password: TEST_PASSWORD });
});
