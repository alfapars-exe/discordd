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
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { ACCOUNT_FILE, CHANNEL_NOTIFICATION_FIXTURE_FILE, E2E_RUN_ID, PENDING_NOTIFICATION_RECIPIENT_FILE } from "../playwright.config";

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

export type ChannelNotificationFixture = {
  owner: TestAccount;
  recipient: TestAccount;
  serverName: string;
  serverId: string;
  channelId: string;
  mutedChannelId: string;
  privateChannelId: string;
};

export function readTestAccount(): TestAccount {
  return JSON.parse(readFileSync(ACCOUNT_FILE, "utf8")) as TestAccount;
}

export function writeTestAccount(account: TestAccount): void {
  mkdirSync(dirname(ACCOUNT_FILE), { recursive: true });
  writeFileSync(ACCOUNT_FILE, JSON.stringify(account, null, 2), { mode: 0o600 });
  if (process.platform !== "win32") chmodSync(ACCOUNT_FILE, 0o600);
}

/**
 * Reads the run-local, disposable two-user channel-notification fixture.
 * The file contains throwaway login credentials and must remain in e2e/.tmp.
 */
export function readChannelNotificationFixture(): ChannelNotificationFixture {
  return JSON.parse(readFileSync(CHANNEL_NOTIFICATION_FIXTURE_FILE, "utf8")) as ChannelNotificationFixture;
}

/**
 * Read-only test observer for the queue row belonging to a unique E2E message.
 * It can only inspect the exact Playwright-owned run DB under e2e/.tmp; no
 * service endpoint or developer database is involved.
 */
export function channelNotificationQueueState(messageMarker: string): { messages: number; pendingJobs: number } {
  const tmpRoot = resolve(dirname(CHANNEL_NOTIFICATION_FIXTURE_FILE));
  const rootStat = lstatSync(tmpRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("disposable E2E root is not a real directory");
  if (!/^run-\d+-\d+-[a-f0-9]{16}$/.test(E2E_RUN_ID)) {
    throw new Error("Playwright disposable run identity is invalid");
  }
  const runDir = resolve(tmpRoot, E2E_RUN_ID);
  const runRelative = relative(tmpRoot, runDir);
  if (!runRelative || runRelative === ".." || runRelative.startsWith(`..${sep}`)) {
    throw new Error("disposable E2E run directory escaped its owner root");
  }
  const runStat = lstatSync(runDir);
  if (!runStat.isDirectory() || runStat.isSymbolicLink()) throw new Error("disposable E2E run directory is not an owned directory");
  const realRoot = realpathSync(tmpRoot);
  const realRunDir = realpathSync(runDir);
  const realRunRelative = relative(realRoot, realRunDir);
  if (!realRunRelative || realRunRelative === ".." || realRunRelative.startsWith(`..${sep}`)) {
    throw new Error("real disposable E2E run directory escaped its owner root");
  }
  const dbPath = resolve(runDir, "hichat-e2e.db");
  const dbStat = existsSync(dbPath) ? lstatSync(dbPath) : null;
  if (dirname(dbPath) !== runDir || !dbStat?.isFile() || dbStat.isSymbolicLink()) {
    throw new Error("owned E2E run does not contain a regular disposable database");
  }
  const realDbPath = realpathSync(dbPath);
  if (dirname(realDbPath) !== realRunDir) throw new Error("real E2E database escaped its owned run directory");
  const probeName = process.platform === "win32" ? "hichat-e2e-queue-probe.exe" : "hichat-e2e-queue-probe";
  const binDir = resolve(runDir, "bin");
  const binStat = lstatSync(binDir);
  if (!binStat.isDirectory() || binStat.isSymbolicLink()) throw new Error("E2E binary directory is not a real directory");
  const realBinDir = realpathSync(binDir);
  const binRelative = relative(realRunDir, realBinDir);
  if (!binRelative || binRelative === ".." || binRelative.startsWith(`..${sep}`)) {
    throw new Error("real E2E binary directory escaped its owner root");
  }
  const probePath = resolve(binDir, probeName);
  const probeStat = lstatSync(probePath);
  if (!probeStat.isFile() || probeStat.isSymbolicLink()) throw new Error("disposable queue probe is not a regular file");
  const realProbePath = realpathSync(probePath);
  if (dirname(realProbePath) !== realBinDir) throw new Error("real queue probe escaped its owned binary directory");
  const raw = execFileSync(realProbePath, [realDbPath, messageMarker], {
    encoding: "utf8",
    timeout: 5_000,
    windowsHide: true,
  }).trim();
  const counts = raw.split(/\s+/).map(Number);
  if (counts.length !== 2 || counts.some((count) => !Number.isSafeInteger(count) || count < 0)) {
    throw new Error("invalid disposable queue probe result");
  }
  return { messages: counts[0], pendingJobs: counts[1] };
}

export function writeChannelNotificationFixture(fixture: ChannelNotificationFixture): void {
  mkdirSync(dirname(CHANNEL_NOTIFICATION_FIXTURE_FILE), { recursive: true });
  writeFileSync(CHANNEL_NOTIFICATION_FIXTURE_FILE, JSON.stringify(fixture, null, 2), { mode: 0o600 });
  if (process.platform !== "win32") chmodSync(CHANNEL_NOTIFICATION_FIXTURE_FILE, 0o600);
}

function writePendingNotificationRecipient(account: TestAccount): void {
  mkdirSync(dirname(PENDING_NOTIFICATION_RECIPIENT_FILE), { recursive: true });
  writeFileSync(PENDING_NOTIFICATION_RECIPIENT_FILE, JSON.stringify(account, null, 2), { mode: 0o600 });
  if (process.platform !== "win32") chmodSync(PENDING_NOTIFICATION_RECIPIENT_FILE, 0o600);
}

/**
 * Builds a disposable real-API fixture in the Playwright-owned fresh SQLite
 * database. It uses the already registered E2E account as server owner, adds
 * one recipient through a one-use invite, then prepares readable, muted, and
 * ViewChannel/ReadMessages-denied text channels. The recipient remains
 * explicitly opted out until a browser test turns the preference on.
 *
 * All API credentials stay in the page function's memory and are never logged
 * or written to disk. The fixture file contains only generated test account
 * credentials plus IDs, and is gitignored under e2e/.tmp.
 */
export async function provisionChannelNotificationFixture(page: Page, owner: TestAccount, existingRecipient?: TestAccount): Promise<void> {
  // Never let a prior interrupted run's credentials masquerade as this run's
  // fixture if API provisioning fails before the final write.
  if (!existingRecipient) rmSync(CHANNEL_NOTIFICATION_FIXTURE_FILE, { force: true });
  const pendingRecipient = !existingRecipient && existsSync(PENDING_NOTIFICATION_RECIPIENT_FILE)
    ? JSON.parse(readFileSync(PENDING_NOTIFICATION_RECIPIENT_FILE, "utf8")) as TestAccount
    : undefined;
  const recipient = existingRecipient ?? pendingRecipient ?? { username: uniqueUsername(), password: generateTestPassword() };
  if (!existingRecipient) writePendingNotificationRecipient(recipient);
  const serverName = `E2E Notification ${Date.now()}`;
  const ids = await page.evaluate(async ({ recipient, serverName, existingRecipient, pendingRecipient }) => {
    const reuseRecipient = existingRecipient || pendingRecipient;
    type Envelope<T> = { success?: boolean; data?: T };
    type Server = { id: string };
    type Channel = { id: string; name: string; type: string; category_id?: string | null };
    type Group = { channels?: Channel[] };
    type Role = { id: string; name: string };

    const fail = (path: string, status: number): never => {
      throw new Error(`notification fixture API request failed (${status} ${path})`);
    };
    const request = async <T>(path: string, token: string, method = "GET", body?: unknown): Promise<T> => {
      const response = await fetch(`/api${path}`, {
        method,
        credentials: "omit",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "X-HiChat-Client": "web",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) return fail(path, response.status);
      const envelope = await response.json() as Envelope<T>;
      if (envelope.success !== true || envelope.data === undefined) return fail(path, response.status);
      return envelope.data;
    };

    // Refresh uses only the current owner session's HttpOnly cookie; all other
    // calls use its short-lived bearer token with cookies omitted.
    const refresh = await fetch("/api/auth/refresh", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", "X-HiChat-Client": "web" },
      body: "{}",
    });
    if (!refresh.ok) return fail("/auth/refresh", refresh.status);
    const ownerEnvelope = await refresh.json() as Envelope<{ access_token?: string }>;
    const ownerToken = ownerEnvelope.data?.access_token;
    if (ownerEnvelope.success !== true || !ownerToken) return fail("/auth/refresh", refresh.status);

    let recipientResponse = await fetch(reuseRecipient ? "/api/auth/login" : "/api/auth/register", {
      method: "POST",
      // Avoid replacing the owner browser's refresh cookie with the recipient's.
      credentials: "omit",
      headers: { "Content-Type": "application/json", "X-HiChat-Client": "web" },
      body: JSON.stringify(reuseRecipient
        ? { username: recipient.username, password: recipient.password }
        : {
          username: recipient.username,
          password: recipient.password,
          display_name: "E2E Notification Recipient",
          email: `${recipient.username}@example.test`,
        }),
    });
    if (reuseRecipient && recipientResponse.status === 401) {
      // A setup retry may have persisted credentials just before registration
      // succeeded. Reuse those same credentials instead of consuming another
      // registration slot for a duplicate account.
      recipientResponse = await fetch("/api/auth/register", {
        method: "POST",
        credentials: "omit",
        headers: { "Content-Type": "application/json", "X-HiChat-Client": "web" },
        body: JSON.stringify({
          username: recipient.username,
          password: recipient.password,
          display_name: "E2E Notification Recipient",
          email: `${recipient.username}@example.test`,
        }),
      });
    }
    const recipientAuthPath = reuseRecipient ? "/auth/login" : "/auth/register";
    if (!recipientResponse.ok) return fail(recipientAuthPath, recipientResponse.status);
    const recipientEnvelope = await recipientResponse.json() as Envelope<{ access_token?: string; user?: { id?: string } }>;
    const recipientToken = recipientEnvelope.data?.access_token;
    const recipientId = recipientEnvelope.data?.user?.id;
    if (recipientEnvelope.success !== true || !recipientToken || !recipientId) return fail(recipientAuthPath, recipientResponse.status);

    const server = await request<Server>("/servers", ownerToken, "POST", {
      name: serverName,
      host_type: "self_hosted",
      livekit_url: "https://example.invalid",
      livekit_key: "e2e-test-only-key",
      livekit_secret: "e2e-test-only-secret",
    });
    const grouped = await request<Group[]>(`/servers/${server.id}/channels`, ownerToken);
    const channels = grouped.flatMap((group) => group.channels ?? []);
    const general = channels.find((channel) => channel.name === "general" && channel.type === "text");
    if (!general) throw new Error("notification fixture could not find the seeded general text channel");

    const createChannel = (name: string) => request<Channel>(`/servers/${server.id}/channels`, ownerToken, "POST", {
      name,
      type: "text",
      category_id: general.category_id ?? "",
      topic: "Disposable channel notification E2E fixture",
    });
    const muted = await createChannel("fixture-muted");
    const privateChannel = await createChannel("fixture-private");

    const roles = await request<Role[]>(`/servers/${server.id}/roles`, ownerToken);
    const everyone = roles.find((role) => role.name.toLowerCase() === "everyone");
    if (!everyone) throw new Error("notification fixture could not find the everyone role");
    await request(`/servers/${server.id}/channels/${privateChannel.id}/permissions/${everyone.id}`, ownerToken, "PUT", {
      allow: 0,
      deny: 6144, // ViewChannel | ReadMessages
    });

    const invite = await request<{ code: string }>(`/servers/${server.id}/invites`, ownerToken, "POST", {
      max_uses: 1,
      expires_in: 30,
      channel_id: general.id,
    });
    await request(`/servers/join`, recipientToken, "POST", { invite_code: invite.code });
    await request(`/servers/${server.id}/channels/${muted.id}/mute`, recipientToken, "POST", { duration: "forever" });
    await request(`/users/me/preferences`, recipientToken, "PATCH", {
      expected_user_id: recipientId,
      data: { notifications: { channelMessageNotifications: false } },
    });

    return { serverId: server.id, channelId: general.id, mutedChannelId: muted.id, privateChannelId: privateChannel.id };
  }, {
    recipient,
    serverName,
    existingRecipient: !!existingRecipient,
    pendingRecipient: !!pendingRecipient,
  });

  writeChannelNotificationFixture({ owner, recipient, serverName, ...ids });
  if (!existingRecipient) rmSync(PENDING_NOTIFICATION_RECIPIENT_FILE, { force: true });
}

/** Clear prior-attempt rows by deleting only our synthetic fixture server, then recreate it. */
export async function resetChannelNotificationFixture(page: Page): Promise<void> {
  const fixture = readChannelNotificationFixture();
  if (!/^E2E Notification \d+$/.test(fixture.serverName)) {
    throw new Error("fixture cleanup refused a non-synthetic server name");
  }
  const status = await page.evaluate(async ({ serverId, serverName, ownerUsername }) => {
    const refresh = await fetch("/api/auth/refresh", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", "X-HiChat-Client": "web" },
      body: "{}",
    });
    if (!refresh.ok) return refresh.status;
    const envelope = await refresh.json() as { success?: boolean; data?: { access_token?: string } };
    const token = envelope.data?.access_token;
    if (envelope.success !== true || !token) return refresh.status;
    const authHeaders = { Authorization: `Bearer ${token}`, "X-HiChat-Client": "web" };
    const meResponse = await fetch("/api/users/me", { credentials: "omit", headers: authHeaders });
    if (!meResponse.ok) return meResponse.status;
    const meEnvelope = await meResponse.json() as { success?: boolean; data?: { id?: string; username?: string } };
    const me = meEnvelope.data;
    if (meEnvelope.success !== true || !me?.id || me.username !== ownerUsername) return 409;
    const serverResponse = await fetch(`/api/servers/${serverId}`, { credentials: "omit", headers: authHeaders });
    if (serverResponse.status === 404) return 404;
    if (!serverResponse.ok) return serverResponse.status;
    const serverEnvelope = await serverResponse.json() as { success?: boolean; data?: { id?: string; name?: string; owner_id?: string } };
    const server = serverEnvelope.data;
    if (serverEnvelope.success !== true || server?.id !== serverId || server.name !== serverName || server.owner_id !== me.id) return 409;
    const response = await fetch(`/api/servers/${serverId}`, {
      method: "DELETE",
      credentials: "omit",
      headers: authHeaders,
    });
    return response.status;
  }, { serverId: fixture.serverId, serverName: fixture.serverName, ownerUsername: fixture.owner.username });
  // A prior failed retry may already have deleted the server before it failed
  // to recreate the fixture. Treat that as an idempotent cleanup result.
  if (status !== 200 && status !== 204 && status !== 404) {
    throw new Error(`notification fixture server cleanup failed (${status})`);
  }
  await provisionChannelNotificationFixture(page, fixture.owner, fixture.recipient);
  await page.reload();
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
  await loginAsCredentials(page, readTestAccount());
}

export async function loginAsNotificationOwner(page: Page): Promise<void> {
  await loginAsCredentials(page, readChannelNotificationFixture().owner);
}

export async function loginAsNotificationRecipient(page: Page): Promise<void> {
  await loginAsCredentials(page, readChannelNotificationFixture().recipient);
}

/** Logs a fixture account into a fresh browser context via the real login form. */
export async function loginAsCredentials(page: Page, account: TestAccount): Promise<void> {
  const { username, password } = account;

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
