/**
 * Shared E2E helpers.
 *
 * Selector policy — everything below is derived from the real components, not
 * invented. No production file was modified to make these tests runnable.
 *
 *   RegisterPage.tsx / LoginPage.tsx  → <label htmlFor> pairs, so getByLabel.
 *   AddServerModal.tsx                → button text + the server-name
 *                                       placeholder "My Awesome Server".
 *   ChannelItem.tsx                   → <button> whose label span holds the
 *                                       channel name.
 *   MessageInput.tsx                  → textarea placeholder "Message #general",
 *                                       plus the hidden <input type="file">.
 *   MessageList.tsx                   → the .messages-scroll container. It has
 *                                       no role and no data-testid; the class
 *                                       is the only handle, and exactly one
 *                                       instance is mounted at a time (the
 *                                       other is the loading skeleton branch).
 *   Toast.tsx                         → role="alert".
 *
 * i18n: client/src/i18n/index.ts defaults to Turkish and detects language from
 * localStorage["language"] only. Every page therefore gets an init script
 * pinning "en" so the English strings above are what actually renders.
 */

import { expect, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ACCOUNT_FILE } from "../playwright.config";

/** Smallest valid PNG (1x1, transparent) — passes the server's MIME sniff. */
const ONE_BY_ONE_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

/**
 * Password for the throwaway account this run registers.
 *
 * Generated rather than written down: a literal in the repo is a hard-coded
 * credential no matter how disposable the account is, and static analysis is
 * right to flag it. Only auth.setup.ts calls this — it persists the value
 * into ACCOUNT_FILE, and every spec reads it back from there, so the tests
 * never need to know it. `Aa1!` prefixes the hex to satisfy the register
 * form's composition rules; the server's own floor is 8 characters.
 */
export function generateTestPassword(): string {
  return `Aa1!${randomBytes(12).toString("hex")}`;
}

export function uniqueUsername(): string {
  // Usernames are constrained to [a-zA-Z0-9_] by the register form's pattern.
  // crypto over Math.random: the suffix is what keeps parallel or rapidly
  // repeated runs from colliding on an already-registered name, so it should
  // come from a generator with no birthday surprises.
  return `e2e_${Date.now()}_${randomBytes(4).toString("hex")}`;
}

/** Pin the UI to English before any app code runs. */
export async function forceEnglish(page: Page): Promise<void> {
  await page.addInitScript(() => {
    globalThis.localStorage.setItem("language", "en");
  });
}

/**
 * Writes a file into a fresh temp dir and returns its path.
 *
 * A real file on disk (rather than setInputFiles' in-memory buffer form) keeps
 * the File.type sniffing identical to what a browser file picker produces,
 * which is what utils/fileValidation.ts partitions on.
 */
export function writeFixture(filename: string, contents: Buffer): string {
  const dir = mkdtempSync(join(tmpdir(), "hichat-e2e-fixture-"));
  const path = join(dir, filename);
  writeFileSync(path, contents);
  return path;
}

export function writePngFixture(filename = "pixel.png"): string {
  return writeFixture(filename, Buffer.from(ONE_BY_ONE_PNG_B64, "base64"));
}

/**
 * Writes a file whose extension is NOT in fileValidation.ts's allow-list
 * (jpg/jpeg/png/gif/webp/mp4/webm/mp3/ogg/pdf/txt). Chromium reports an empty
 * File.type for .bin, so effectiveMime() falls through to the extension map,
 * misses, and the file lands in the `rejected` partition.
 */
export function writeDisallowedFixture(filename = "payload.bin"): string {
  return writeFixture(filename, Buffer.from("not an allowed attachment type"));
}

/**
 * Dismisses the two one-time post-login overlays.
 *
 * WelcomeModal and DownloadPromptModal are gated on the server-side user flags
 * has_seen_welcome / has_seen_download_prompt and dismissing them PATCHes the
 * user, so this only has work to do on the very first authenticated render of
 * a run. It is written to be a no-op afterwards.
 *
 * Order matters: the download overlay stacks above the welcome one and would
 * otherwise swallow the click meant for "Got it!".
 */
export async function dismissOnboardingOverlays(page: Page): Promise<void> {
  const downloadDismiss = page.getByRole("button", { name: /Maybe later/i });
  if (await downloadDismiss.isVisible().catch(() => false)) {
    await downloadDismiss.click();
    await page
      .locator(".download-prompt-overlay")
      .waitFor({ state: "detached", timeout: 5_000 })
      .catch(() => {});
  }

  const welcomeBtn = page.getByRole("button", { name: /Got it!/i });
  if (await welcomeBtn.isVisible().catch(() => false)) {
    await welcomeBtn.click();
    await page
      .locator(".welcome-overlay")
      .waitFor({ state: "detached", timeout: 5_000 })
      .catch(() => {});
  }
}

export type TestAccount = { username: string; password: string };

export function readTestAccount(): TestAccount {
  return JSON.parse(readFileSync(ACCOUNT_FILE, "utf8")) as TestAccount;
}

export function writeTestAccount(account: TestAccount): void {
  mkdirSync(dirname(ACCOUNT_FILE), { recursive: true });
  writeFileSync(ACCOUNT_FILE, JSON.stringify(account, null, 2));
}

/**
 * Logs the shared account in through the real login form.
 *
 * Every test does this rather than restoring a saved storageState, because the
 * session lives in the HttpOnly hichat_refresh cookie and the server rotates
 * (and invalidates) that token on refresh — a replayed snapshot authenticates
 * once and then 401s. See ACCOUNT_FILE in playwright.config.ts.
 *
 * This is free with respect to rate limiting: handlers/auth.go calls
 * loginLimiter.Reset(ip) on every successful login.
 */
export async function loginAsTestUser(page: Page): Promise<void> {
  const { username, password } = readTestAccount();

  await forceEnglish(page);
  await page.goto("/login");

  await page.getByLabel(/^Username/i).fill(username);
  await page.getByLabel(/^Password/i).fill(password);
  await page.getByRole("button", { name: /^Log In$/ }).click();

  await expect(page).toHaveURL(/\/channels/, { timeout: 20_000 });
  await expect(page.getByRole("button", { name: /Add Server/i })).toBeVisible({
    timeout: 20_000,
  });
  await dismissOnboardingOverlays(page);
}

/** The message stream container — see the selector policy note above. */
export function messageList(page: Page) {
  return page.locator(".messages-scroll");
}

/** The composer textarea for the currently open channel. */
export function composer(page: Page) {
  return page.getByPlaceholder(/^Message #/i);
}

/**
 * Logs in and opens a brand-new server's #general channel.
 *
 * A fresh server per test rather than a shared one: POST /api/servers carries
 * no rate limit and no per-user cap, and an empty message stream is what makes
 * the count-based assertions (`toHaveCount(0)`, "exactly one attachment")
 * mean what they say. Reusing one server would leave earlier tests' messages
 * in the same stream.
 *
 * server_service.go's CreateServer seeds a text channel literally named
 * "general" — server-side and not localized, so the name is stable.
 */
export async function openFreshChannel(page: Page): Promise<void> {
  await loginAsTestUser(page);
  await createServer(page, `E2E Server ${Date.now()}`);

  const general = page.locator("button.ch-tree-item", { hasText: "general" }).first();
  await expect(general).toBeVisible({ timeout: 15_000 });
  await general.click();

  await expect(composer(page)).toBeVisible({ timeout: 15_000 });
  // Wait out the initial (empty) message fetch so a later toHaveCount(0) is
  // asserting "nothing was added" rather than "nothing has loaded yet".
  await expect(messageList(page)).toBeVisible({ timeout: 15_000 });
}

/**
 * Drives AddServerModal's create wizard.
 *
 * Two steps for the default "HiChat! Hosted" host type: name, then host type.
 * The footer's primary button reads "Next" on every step except the last,
 * where it becomes "Create" (t("createButton")).
 */
export async function createServer(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: /Add Server/i }).click();

  // Choice view → the "Create Server" card.
  await page.locator("button.add-server-choice-btn", { hasText: "Create Server" }).click();

  // Step 1 — name.
  await page.getByPlaceholder("My Awesome Server").fill(name);
  await page.getByRole("button", { name: /^Next$/ }).click();

  // Step 2 — host type; "HiChat! Hosted" is preselected.
  await page.getByRole("button", { name: /^Create$/ }).click();

  // Toast confirms the create round-trip landed before we look for channels.
  // role is "status", not "alert": Toast.tsx reserves the assertive "alert"
  // role for error/warning toasts and announces success politely via "status".
  await expect(page.getByRole("status").filter({ hasText: /Server created successfully/i })).toBeVisible({
    timeout: 15_000,
  });
}

/**
 * Asserts an <img> is not merely present but actually decoded.
 *
 * This covers the media-cookie attachment-auth path: /api/uploads/* is
 * auth-gated and an <img> cannot send an Authorization header, so inline
 * attachments depend on the hichat_media cookie.
 *
 * Measured behaviour of the two ways that path can break (verified with a
 * throwaway negative-control spec):
 *   - Hard 401: MessageAttachments retries once, then latches imgFailed and
 *     swaps in the generic file card, so the <img> leaves the DOM entirely.
 *   - Request never completes: no onError fires, the <img> stays mounted, and
 *     because .msg-attachment-img sets only max-width/max-height it collapses
 *     to a 0x0 box.
 *
 * Both are caught. naturalWidth is still the right assertion to write: it is
 * the one that means "the bytes arrived and decoded" rather than "the element
 * happens to have a layout box", so it stays correct if that CSS rule ever
 * gains a min-height or a placeholder background — the change that would
 * quietly turn a toBeVisible() check into a no-op.
 */
export async function expectImageActuallyLoaded(
  page: Page,
  selector: string,
  timeout = 20_000,
): Promise<void> {
  await expect
    .poll(
      async () =>
        page.evaluate((sel) => {
          const img = document.querySelector(sel) as HTMLImageElement | null;
          return img?.naturalWidth ?? -1;
        }, selector),
      {
        timeout,
        message: `expected ${selector} to decode (naturalWidth > 0) — a 0 here means the media cookie did not authenticate the /api/uploads request`,
      },
    )
    .toBeGreaterThan(0);
}
