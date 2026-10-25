/**
 * Shared E2E helpers.
 *
 * Selector policy — everything below is derived from the real components, not
 * invented. No production file was modified to make these tests runnable.
 *
 *   RegisterPage.tsx / LoginPage.tsx  → <label htmlFor> pairs, so getByLabel.
 *   ServerRail.tsx                    → the navigation landmark is labelled
 *                                       "Servers"; each server is an
 *                                       accessible button named for the server.
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
 * Writes a file larger than MAX_FILE_SIZE (client/src/utils/constants.ts,
 * 25 MB), so validateFiles() puts it in the `rejected` partition with reason
 * "too_large".
 *
 * Size is the ONLY rejection reason. The type allow-list this helper used to
 * trip was deliberately removed in cdb6601f ("accept all file types; harden
 * serving against stored XSS") — the boundary moved to serve time, where
 * /api/uploads re-sniffs the bytes and forces anything non-displayable to
 * octet-stream + attachment + CSP sandbox. A `.bin` file is now a perfectly
 * valid upload, so an over-size file is the only way left to exercise the
 * rejection path.
 *
 * Buffer.alloc gives zeroed pages; the content is irrelevant because the
 * partition happens on File.size before a byte is read.
 */
export function writeOversizeFixture(filename = "too-big.bin"): string {
  const MAX_FILE_SIZE = 25 * 1024 * 1024;
  return writeFixture(filename, Buffer.alloc(MAX_FILE_SIZE + 1024));
}

/**
 * Dismisses the two one-time post-login overlays.
 *
 * WelcomeModal and DownloadPromptModal are gated on the server-side user flags
 * has_seen_welcome / has_seen_download_prompt and dismissing them PATCHes the
 * user, so this only has work to do on the very first authenticated render of
 * a run. It is written to be a no-op afterwards.
 *
 * Order matters: the download prompt becomes eligible only after welcome is
 * dismissed. Wait for hydrated profile state before checking either overlay.
 */
export async function dismissOnboardingOverlays(page: Page): Promise<void> {
  // User Profile is hydrated from /users/me in the same auth-store update that
  // supplies the flags controlling these first-run overlays.
  await expect(page.getByRole("button", { name: "User Profile", exact: true })).toBeVisible({
    timeout: 20_000,
  });

  const welcomeOverlay = page.locator(".welcome-overlay");
  if (await welcomeOverlay.isVisible().catch(() => false)) {
    // Use the component's stable class because its translated label can vary.
    await page.locator(".welcome-btn").click();
    await expect(welcomeOverlay).toBeHidden({ timeout: 5_000 });
  }

  // DownloadPromptModal is gated on has_seen_welcome, so it mounts only after
  // the welcome dismissal updates the auth store.
  const downloadOverlay = page.locator(".download-prompt-overlay");
  if (await downloadOverlay.isVisible().catch(() => false)) {
    await page.locator(".download-prompt-btn-dismiss").click();
    await expect(downloadOverlay).toBeHidden({ timeout: 5_000 });
  }
}

/** Assert the signed-in shell currently exposed by the single-server UI. */
export async function expectSignedInShell(page: Page): Promise<void> {
  const serverRail = page.getByRole("navigation", { name: "Servers", exact: true });
  await expect(serverRail).toBeVisible({ timeout: 20_000 });
  await expect(serverRail.getByRole("button", { name: "Friends", exact: true })).toBeVisible();
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
  await expectSignedInShell(page);
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
  await provisionServerForE2E(page, `E2E Server ${Date.now()}`);

  const general = page.locator("button.ch-tree-item", { hasText: "general" }).first();
  await expect(general).toBeVisible({ timeout: 15_000 });
  await general.click();

  await expect(composer(page)).toBeVisible({ timeout: 15_000 });
  // Wait out the initial (empty) message fetch so a later toHaveCount(0) is
  // asserting "nothing was added" rather than "nothing has loaded yet".
  await expect(messageList(page)).toBeVisible({ timeout: 15_000 });
}

/**
 * Provisions an isolated server through the real API, then opens it through
 * the current ServerRail UI. The single-server deployment deliberately hides
 * the create-server button; API provisioning keeps message/upload E2E tests
 * isolated without changing that product setting. A self-hosted fixture avoids
 * the one-hosted-server-per-user limit and uses inert, test-only credentials.
 */
export async function provisionServerForE2E(page: Page, name: string): Promise<void> {
  // The access token intentionally lives only in the app module's memory, so
  // Playwright's separate APIRequestContext cannot authenticate directly.
  // Refresh and create within the page origin; keep the token in-page and out
  // of test logs, then reload so the app adopts the rotated refresh cookie.
  const result = await page.evaluate(async (serverName) => {
    const refresh = await fetch("/api/auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-HiChat-Client": "web" },
      credentials: "include",
      body: JSON.stringify({}),
    });
    if (!refresh.ok) return { status: refresh.status, server: null };
    const refreshed = await refresh.json();
    const token = refreshed?.data?.access_token;
    if (!token) return { status: refresh.status, server: null };

    const response = await fetch("/api/servers", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
        "X-HiChat-Client": "web",
      },
      credentials: "include",
      body: JSON.stringify({
        name: serverName,
        host_type: "self_hosted",
        livekit_url: "https://example.invalid",
        livekit_key: "e2e-test-only-key",
        livekit_secret: "e2e-test-only-secret",
      }),
    });
    const body = await response.json().catch(() => null);
    return { status: response.status, server: body?.data ?? body };
  }, name);
  expect(result.status).toBe(201);
  const server = result.server as { id: string; name: string };
  expect(server.id).toBeTruthy();
  expect(server.name).toBe(name);

  // Refresh hydrates the Zustand server list from the isolated E2E database.
  await page.reload();
  const serverButton = page.getByRole("button", { name, exact: true });
  await expect(serverButton).toBeVisible({ timeout: 15_000 });
  await dismissOnboardingOverlays(page);
  await serverButton.click();
  await expect(page.getByRole("main").getByRole("region", { name, exact: true })).toBeVisible({
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
