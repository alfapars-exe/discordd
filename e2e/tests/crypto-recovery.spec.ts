import { expect, test, type Page, type Request, type BrowserContext } from "@playwright/test";
import { randomBytes, webcrypto } from "node:crypto";
import {
  composer, dismissOnboardingOverlays, fixtureApi, loginAsNotificationOwner,
  messageList, readChannelNotificationFixture, resetChannelNotificationFixture, loginAsNotificationRecipient,
} from "./helpers";

async function encryptionSettings(page: Page) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await settings.getByRole("button", { name: "Encryption", exact: true }).click();
  await expect(settings.locator(".e2ee-fingerprint")).toHaveText(/^[a-f0-9]{4}( [a-f0-9]{4}){7}$/);
  return settings;
}

async function openChannel(page: Page, serverName: string) {
  await page.locator("nav.server-rail").getByRole("button", { name: serverName, exact: true }).click();
  await page.locator("button.ch-tree-item").filter({ hasText: "general" }).first().click();
  await expect(composer(page)).toBeVisible();
}

async function sendEncryptedFixtureMessage(page: Page, endpoint: string, content: string, waitForDraftClear = true) {
  await page.bringToFront();
  const input = page.getByRole("textbox", { name: /^Message [#@]/i });
  await input.fill(content);
  const send = page.getByRole("button", { name: "Send Message", exact: true });
  await expect(send).toBeEnabled();
  const [response] = await Promise.all([
    page.waitForResponse(response => new URL(response.url()).pathname === endpoint && response.request().method() === "POST"),
    send.click(),
  ]);
  const body = await response.json();
  expect(response.status(), typeof body.error === "string" ? body.error : "Encrypted fixture send rejected").toBe(201);
  const message = body.data;
  expect(message.encryption_version).toBe(1);
  expect(JSON.stringify(message)).not.toContain(content);
  await expect(page.locator(`#msg-${message.id}`)).toContainText(content);
  if (waitForDraftClear) await expect(input).toHaveValue("");
  return message;
}

async function expectEncryptedSearchPages(page: Page, query: string, newestFirst: string[]) {
  const remoteSearches: string[] = [];
  const observe = (request: Request) => {
    const pathname = new URL(request.url()).pathname;
    if (/^\/api\/(?:servers|dms)\/[^/]+\/search$/.test(pathname)) remoteSearches.push(pathname);
  };
  page.on("request", observe);
  try {
    await page.getByRole("button", { name: "Search Messages", exact: true }).click();
    const panel = page.locator(".search-panel");
    await panel.getByPlaceholder("Search messages...", { exact: true }).fill(query.toUpperCase());
    await expect(panel.locator(".search-count")).toHaveText(`${newestFirst.length} results`);
    await expect(panel.locator(".search-result-content")).toHaveText(newestFirst.slice(0, 25));
    await panel.getByRole("button", { name: "Next", exact: true }).click();
    await expect(panel.locator(".search-result-content")).toHaveText(newestFirst.slice(25));
    await panel.getByRole("button", { name: "Previous", exact: true }).click();
    await expect(panel.locator(".search-result-content")).toHaveText(newestFirst.slice(0, 25));
    expect(remoteSearches).toEqual([]);
    await panel.locator(".search-close").click();
    await expect(panel).toBeHidden();
  } finally {
    page.off("request", observe);
  }
}

async function openDM(page: Page, peerName: string) {
  await page.locator("nav.server-rail").getByRole("button", { name: "Friends", exact: true }).click();
  await page.getByRole("complementary").getByRole("button").filter({ hasText: peerName }).first().click();
  await expect(page.getByPlaceholder(/^Message @/i)).toBeVisible();
}

// Independent fixture preparation: emulate a v1 writer that encrypted the
// same cache receipt before source tags existed. Product code is not imported.
async function removeBackupSourceTag(page: Page, password: string, messageId: string) {
  const backup = await fixtureApi<{ version: number; algorithm: string; encrypted_data: string; nonce: string; salt: string }>(page, "/e2ee/key-backup");
  expect(backup.algorithm).toBe("aes-256-gcm+pbkdf2-2000000");
  const material = await webcrypto.subtle.importKey("raw", Buffer.from(password, "utf8"), "PBKDF2", false, ["deriveKey"]);
  const key = await webcrypto.subtle.deriveKey({ name: "PBKDF2", salt: Buffer.from(backup.salt, "base64"), iterations: 2_000_000, hash: "SHA-256" }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const plaintext = await webcrypto.subtle.decrypt({ name: "AES-GCM", iv: Buffer.from(backup.nonce, "base64") }, key, Buffer.from(backup.encrypted_data, "base64"));
  const contents = JSON.parse(Buffer.from(plaintext).toString("utf8")) as { version: number; messageCache: Array<{ messageId: string; encryptedSourceTag?: string }> };
  expect(contents.version).toBe(1);
  const receipt = contents.messageCache.find(row => row.messageId === messageId);
  expect(receipt).toBeDefined();
  if (!receipt) throw new Error("fixture backup did not include the sent message");
  expect(receipt.encryptedSourceTag).toMatch(/^channel-v1:/);
  delete receipt.encryptedSourceTag;
  // Never reuse the original GCM nonce when changing authenticated plaintext.
  const nonce = randomBytes(12);
  const encrypted = await webcrypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, Buffer.from(JSON.stringify(contents), "utf8"));
  await fixtureApi(page, "/e2ee/key-backup", "PUT", {
    version: backup.version, algorithm: backup.algorithm, salt: backup.salt,
    nonce: nonce.toString("base64"), encrypted_data: Buffer.from(encrypted).toString("base64"),
  });
}

for (const cacheFormat of ["source-tagged", "legacy-unversioned"] as const) {
  test(`a fresh device restores identity and encrypted history (${cacheFormat})`, async ({ browser }) => {
    test.skip(process.env.HICHAT_E2E_CRYPTO_RECOVERY !== "1", "Owns a separate disposable database and identities");
    test.setTimeout(180_000);
    const originalContext = await browser.newContext();
    const restoredContext = await browser.newContext();
    let peerContext: BrowserContext | undefined;
    let dmSearch: { peerName: string; query: string; messages: string[] } | undefined;
    try {
      const original = await originalContext.newPage();
      original.on("console", event => {
        if (event.type() !== "error") return;
        const category = event.text().match(/^\[[^\]]+\][^:{]*/);
        if (category) {
          const code = event.text().match(/e2ee_[a-z_]+|RECIPIENT_NO_KEYS|SELF_FANOUT_UNAVAILABLE|InvalidStateError|TransactionInactiveError|AbortError|Failed to fetch recipient prekey bundles/);
          console.error("Encrypted fixture browser category:", category[0].slice(0, 120), code?.[0] || "unclassified");
        }
      });
      original.on("response", response => {
        const pathname = new URL(response.url()).pathname;
        if (!response.ok() && (pathname.startsWith("/api/e2ee/") || /^\/api\/users\/[^/]+\/(?:devices|prekey-bundles)$/.test(pathname))) {
          console.error("Encrypted fixture API rejection:", {
            route: pathname.replace(/^\/api\/users\/[^/]+\//, "/api/users/:id/"), status: response.status(),
          });
        }
      });
      await loginAsNotificationOwner(original);
      // A retry reuses this run's disposable identity. Remove only its backup
      // before the fixture reset reloads the app, so prior attempts cannot turn
      // the initial set-password step into a change/restore flow.
      await fixtureApi(original, "/e2ee/key-backup", "DELETE");
      await resetChannelNotificationFixture(original);
      const fixture = readChannelNotificationFixture();
      // Establish the backup before enabling encryption so a first-use prompt
      // cannot intercept channel navigation. Refresh it after sending history.
      const password = `Q!${randomBytes(24).toString("hex")}`;
      const initialSettings = await encryptionSettings(original);
      const fingerprint = await initialSettings.locator(".e2ee-fingerprint").innerText();
      await initialSettings.locator("#recoveryPwd").fill(password);
      await initialSettings.locator("#recoveryPwdConfirm").fill(password);
      const initialUpload = original.waitForResponse(response =>
        new URL(response.url()).pathname === "/api/e2ee/key-backup" && response.request().method() === "PUT");
      await initialSettings.getByRole("button", { name: "Set Recovery Password", exact: true }).click();
      expect((await initialUpload).ok()).toBe(true);
      await expect(initialSettings.getByRole("button", { name: "Change Recovery Password", exact: true })).toBeVisible();
      // Successful saving clears both fields; changing the password is then
      // correctly disabled until the user supplies a new one.
      await expect(initialSettings.locator("#recoveryPwd")).toHaveValue("");
      await expect(initialSettings.locator("#recoveryPwdConfirm")).toHaveValue("");
      await expect(original.getByRole("status").filter({ hasText: "Recovery password set successfully" })).toBeVisible();
      await original.keyboard.press("Escape");
      await expect(initialSettings).toBeHidden();
      await fixtureApi(original, `/servers/${fixture.serverId}`, "PATCH", { e2ee_enabled: true });
      await original.reload();
      await dismissOnboardingOverlays(original);
      await openChannel(original, fixture.serverName);
      const plaintext = `encrypted-history-\u00c9t\u00e9-${randomBytes(12).toString("hex")}`;
      const message = await sendEncryptedFixtureMessage(original,
        `/api/servers/${fixture.serverId}/channels/${fixture.channelId}/messages`, plaintext);

      const searchMessages = [plaintext];
      if (cacheFormat === "source-tagged") {
        // The real limiter allows ten sends per trailing five seconds. Pace
        // fixture writes rather than weakening that policy or retrying failures.
        for (let index = 1; index < 26; index++) {
          await original.waitForTimeout(550);
          const content = `${plaintext} ${String(index).padStart(2, "0")}`;
          await sendEncryptedFixtureMessage(original,
            `/api/servers/${fixture.serverId}/channels/${fixture.channelId}/messages`, content);
          searchMessages.push(content);
        }
        await expectEncryptedSearchPages(original, plaintext, searchMessages.toReversed());
        peerContext = await browser.newContext();
        const peer = await peerContext.newPage();
        await loginAsNotificationRecipient(peer);
        const ownerUser = await fixtureApi<{ id: string }>(original, "/users/me");
        const peerUser = await fixtureApi<{ id: string; username: string; display_name?: string }>(peer, "/users/me");
        const dm = await fixtureApi<{ id: string; e2ee_enabled: boolean }>(original, "/dms", "POST", { user_id: peerUser.id });
        if (!dm.e2ee_enabled) await fixtureApi(original, `/dms/channels/${dm.id}/e2ee`, "PATCH", { enabled: true });
        await original.reload();
        await dismissOnboardingOverlays(original);
        const peerName = peerUser.display_name || peerUser.username;
        await openDM(original, peerName);
        const query = `encrypted-dm-\u00c9t\u00e9-${randomBytes(12).toString("hex")}`;
        const messages: string[] = [];
        const dmKeyRequests: string[] = [];
        const dmRosterRequests: string[] = [];
        const observeDMKeys = (request: Request) => {
          const pathname = new URL(request.url()).pathname;
          if (/^\/api\/users\/[^/]+\/prekey-bundles$/.test(pathname)) dmKeyRequests.push(pathname);
          if (pathname === `/api/dms/${dm.id}/device-roster`) dmRosterRequests.push(pathname);
        };
        original.on("request", observeDMKeys);
        for (let index = 0; index < 26; index++) {
          if (index) await original.waitForTimeout(550);
          const content = `${query} ${String(index).padStart(2, "0")}`;
          await sendEncryptedFixtureMessage(original, `/api/dms/${dm.id}/messages`, content, index !== 0);
          messages.push(content);
          if (index === 0) {
            const channels = await fixtureApi<{ id: string; status: string }[]>(peer, "/dms");
            if (channels.find(channel => channel.id === dm.id)?.status === "pending") {
              await fixtureApi(peer, `/dms/channels/${dm.id}/accept`, "POST");
            }
            await expect(original.getByPlaceholder(/^Message @/i)).toBeVisible();
            await expect(original.getByPlaceholder(/^Message @/i)).toHaveValue("");
          }
        }
        original.off("request", observeDMKeys);
        expect(dmRosterRequests).toHaveLength(26);
        // Setup has already registered another owner device. Establish the
        // recipient and self-fanout sessions once each, then reuse their ratchets.
        expect(dmKeyRequests.sort()).toEqual([
          `/api/users/${peerUser.id}/prekey-bundles`,
          `/api/users/${ownerUser.id}/prekey-bundles`,
        ].sort());
        await expectEncryptedSearchPages(original, query, messages.toReversed());
        dmSearch = { peerName, query, messages };

      }

      const settings = await encryptionSettings(original);
      await settings.locator("#recoveryPwd").fill(password);
      await settings.locator("#recoveryPwdConfirm").fill(password);
      const uploaded = original.waitForResponse(response =>
        new URL(response.url()).pathname === "/api/e2ee/key-backup" && response.request().method() === "PUT");
      await settings.getByRole("button", { name: "Change Recovery Password", exact: true }).click();
      expect((await uploaded).ok()).toBe(true);
      await expect(original.getByRole("status").filter({ hasText: "Recovery password set successfully" })).toBeVisible();
      if (cacheFormat === "legacy-unversioned") await removeBackupSourceTag(original, password, message.id);
      await originalContext.close();

      // A new browser context has no cookies, IndexedDB keys, or message cache.
      const restored = await restoredContext.newPage();
      // Emit only fixed diagnostic categories, never plaintext, keys or tokens.
      restored.on("console", event => {
        if (event.type() !== "error") return;
        const category = event.text().match(/Replay detected|No sender key found|Distribution ID mismatch|No initial chain key|Invalid signature/);
        if (category) console.error("Restored history crypto rejection:", category[0]);
      });
      await loginAsNotificationOwner(restored);
      await restored.getByRole("button", { name: "Restore from Recovery Password", exact: true }).click();
      const recovery = restored.locator(".modal-card").filter({ has: restored.getByRole("heading", { name: "Restore Encryption Keys", exact: true }) });
      await recovery.getByPlaceholder("Enter recovery password", { exact: true }).fill(`wrong-${randomBytes(24).toString("hex")}`);
      await recovery.getByRole("button", { name: "Restore Keys", exact: true }).click();
      await expect(restored.getByRole("alert").filter({ hasText: "Invalid recovery password" })).toBeVisible();
      await expect(recovery).toBeVisible();
      await recovery.getByPlaceholder("Enter recovery password", { exact: true }).fill(password);
      await recovery.getByRole("button", { name: "Restore Keys", exact: true }).click();
      await expect(restored.getByRole("status").filter({ hasText: "Keys restored successfully" })).toBeVisible();
      await expect(recovery).toBeHidden();
      const restoredSettings = await encryptionSettings(restored);
      await expect(restoredSettings.locator(".e2ee-fingerprint")).toHaveText(fingerprint);
      await restored.keyboard.press("Escape");
      await expect(restoredSettings).toBeHidden();
      await openChannel(restored, fixture.serverName);
      await expect(restored.locator(`#msg-${message.id}`)).toContainText(plaintext);
      await restored.reload();
      await dismissOnboardingOverlays(restored);
      await expect(restored.locator(`#msg-${message.id}`)).toContainText(plaintext);
      if (cacheFormat === "source-tagged") {
        await expectEncryptedSearchPages(restored, plaintext, searchMessages.toReversed());
        if (!dmSearch) throw new Error("Missing encrypted DM fixture");
        await openDM(restored, dmSearch.peerName);
        await expectEncryptedSearchPages(restored, dmSearch.query, dmSearch.messages.toReversed());
      }
    } finally {
      await Promise.all([originalContext.close(), restoredContext.close(), peerContext?.close()]);
    }
  });
}
