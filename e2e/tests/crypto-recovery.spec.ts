import { expect, test, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import {
  composer, dismissOnboardingOverlays, fixtureApi, loginAsNotificationOwner,
  messageList, readChannelNotificationFixture, resetChannelNotificationFixture,
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

test("a fresh device restores its identity and encrypted history from a password backup", async ({ browser }) => {
  test.skip(process.env.HICHAT_E2E_CRYPTO_RECOVERY !== "1", "Owns a separate disposable database and identities");
  test.setTimeout(180_000);
  const originalContext = await browser.newContext();
  const restoredContext = await browser.newContext();
  try {
    const original = await originalContext.newPage();
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
    await expect(initialSettings.getByRole("button", { name: "Change Recovery Password", exact: true })).toBeEnabled();
    await original.keyboard.press("Escape");
    await expect(initialSettings).toBeHidden();
    await fixtureApi(original, `/servers/${fixture.serverId}`, "PATCH", { e2ee_enabled: true });
    await original.reload();
    await dismissOnboardingOverlays(original);
    await openChannel(original, fixture.serverName);
    const plaintext = `encrypted-history-${randomBytes(12).toString("hex")}`;
    const committed = original.waitForResponse(response =>
      new URL(response.url()).pathname === `/api/servers/${fixture.serverId}/channels/${fixture.channelId}/messages`
      && response.request().method() === "POST");
    await composer(original).fill(plaintext);
    await composer(original).press("Enter");
    const response = await committed;
    expect(response.status()).toBe(201);
    const message = (await response.json()).data;
    expect(message.encryption_version).toBe(1);
    expect(JSON.stringify(message)).not.toContain(plaintext);
    await expect(messageList(original).getByRole("article").filter({ hasText: plaintext })).toHaveCount(1);

    const settings = await encryptionSettings(original);
    await settings.locator("#recoveryPwd").fill(password);
    await settings.locator("#recoveryPwdConfirm").fill(password);
    const uploaded = original.waitForResponse(response =>
      new URL(response.url()).pathname === "/api/e2ee/key-backup" && response.request().method() === "PUT");
    await settings.getByRole("button", { name: "Change Recovery Password", exact: true }).click();
    expect((await uploaded).ok()).toBe(true);
    await expect(original.getByRole("alert").filter({ hasText: "Recovery password set successfully" })).toBeVisible();
    await originalContext.close();

    // A new browser context has no cookies, IndexedDB keys, or message cache.
    const restored = await restoredContext.newPage();
    await loginAsNotificationOwner(restored);
    await restored.getByRole("button", { name: "Restore from Recovery Password", exact: true }).click();
    const recovery = restored.locator(".modal-card").filter({ has: restored.getByRole("heading", { name: "Restore Encryption Keys", exact: true }) });
    await recovery.getByPlaceholder("Enter recovery password", { exact: true }).fill(`wrong-${randomBytes(24).toString("hex")}`);
    await recovery.getByRole("button", { name: "Restore Keys", exact: true }).click();
    await expect(restored.getByRole("alert").filter({ hasText: "Invalid recovery password" })).toBeVisible();
    await expect(recovery).toBeVisible();
    await recovery.getByPlaceholder("Enter recovery password", { exact: true }).fill(password);
    await recovery.getByRole("button", { name: "Restore Keys", exact: true }).click();
    await expect(restored.getByRole("alert").filter({ hasText: "Keys restored successfully" })).toBeVisible();
    await expect(recovery).toBeHidden();
    const restoredSettings = await encryptionSettings(restored);
    await expect(restoredSettings.locator(".e2ee-fingerprint")).toHaveText(fingerprint);
    await restored.keyboard.press("Escape");
    await expect(restoredSettings).toBeHidden();
    await openChannel(restored, fixture.serverName);
    await expect(messageList(restored).getByRole("article").filter({ hasText: plaintext })).toHaveCount(1);
    await restored.reload();
    await dismissOnboardingOverlays(restored);
    await expect(messageList(restored).getByRole("article").filter({ hasText: plaintext })).toHaveCount(1);
  } finally {
    await Promise.all([originalContext.close(), restoredContext.close()]);
  }
});
