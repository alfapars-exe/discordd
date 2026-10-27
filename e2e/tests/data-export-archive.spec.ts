import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test, expect } from "@playwright/test";
import {
  loginAsNotificationOwner,
  loginAsNotificationRecipient,
  readChannelNotificationFixture,
  resetChannelNotificationFixture,
} from "./helpers";
import { createOpaqueAttachmentFixture, readExportZipEntries } from "./dataExportArchive.helpers";

const EXPORT_CREATE_PATH = "/api/users/me/data-exports";

test("owner downloads opaque attachment archive; a second account receives 404", async ({ browser }) => {
  const ownerContext = await browser.newContext();
  const recipientContext = await browser.newContext();
  const ownerPage = await ownerContext.newPage();
  const recipientPage = await recipientContext.newPage();

  try {
    await loginAsNotificationOwner(ownerPage);
    // Retries clean only the synthetic server created by the shared E2E setup.
    await resetChannelNotificationFixture(ownerPage);
    const fixture = readChannelNotificationFixture();
    const opaque = await createOpaqueAttachmentFixture(ownerPage, fixture.serverId, fixture.channelId);
    await loginAsNotificationRecipient(recipientPage);

    await ownerPage.getByRole("button", { name: "Settings", exact: true }).click();
    const settings = ownerPage.getByRole("dialog", { name: "Settings" });
    await expect(settings).toBeVisible();
    await settings.getByRole("button", { name: "Security", exact: true }).click();
    const exportSection = settings.locator('[data-settings-section="data-export"]');
    await expect(exportSection).toBeVisible();

    const createResponsePromise = ownerPage.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === EXPORT_CREATE_PATH && response.request().method() === "POST";
    });
    await exportSection.getByRole("button", { name: "Prepare a new export", exact: true }).click();
    const createResponse = await createResponsePromise;
    expect(createResponse.status()).toBe(201);
    const created = await createResponse.json() as { success?: boolean; data?: { id?: string } };
    expect(created.success).toBe(true);
    const jobID = created.data?.id;
    expect(jobID).toMatch(/^[a-f0-9]{48}$/);
    if (!jobID) throw new Error("export API did not return a job ID");

    const archiveButton = exportSection.getByRole("button", { name: "Download attachments ZIP", exact: true });
    await expect(archiveButton).toBeVisible({ timeout: 60_000 });
    const downloadResponsePromise = ownerPage.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === `${EXPORT_CREATE_PATH}/${jobID}/attachments` && response.request().method() === "GET";
    });
    const downloadPromise = ownerPage.waitForEvent("download");
    await archiveButton.click();
    const [downloadResponse, download] = await Promise.all([downloadResponsePromise, downloadPromise]);
    expect(downloadResponse.status()).toBe(200);
    expect(download.suggestedFilename()).toBe(`hichat-personal-data-${jobID.slice(0, 12)}-attachments.zip`);
    const downloadPath = await download.path();
    if (!downloadPath) throw new Error("Playwright did not provide the synthetic archive download path");

    const zipEntries = readExportZipEntries(await readFile(downloadPath));
    const manifestBytes = zipEntries.get("manifest.json");
    expect(manifestBytes).toBeDefined();
    if (!manifestBytes) throw new Error("export ZIP has no manifest");
    const manifest = JSON.parse(manifestBytes.toString("utf8")) as {
      encrypted_files_note?: string;
      files?: Array<{ id?: string; message_id?: string; path?: string; sha256?: string }>;
    };
    expect(manifest.encrypted_files_note).toContain("preserved as opaque bytes");
    const manifestItem = manifest.files?.find((entry) => entry.id === opaque.attachmentID && entry.message_id === opaque.messageID);
    expect(manifestItem?.path).toBeTruthy();
    expect(manifestItem?.sha256).toBe(createHash("sha256").update(opaque.expectedBytes).digest("hex"));
    const archivedBytes = manifestItem?.path ? zipEntries.get(manifestItem.path) : undefined;
    expect(archivedBytes).toBeDefined();
    expect(archivedBytes).toEqual(opaque.expectedBytes);

    const peerCheck = await recipientPage.evaluate(async ({ id, expectedOrigin }) => {
      const target = new URL(`/api/users/me/data-exports/${encodeURIComponent(id)}/attachments`, window.location.origin);
      if (window.location.origin !== expectedOrigin || target.origin !== expectedOrigin || target.protocol !== "http:" ||
          !["localhost", "127.0.0.1", "[::1]"].includes(target.hostname)) {
        throw new Error("refusing peer archive request outside the exact disposable loopback origin");
      }

      // Keep the bearer token inside this page evaluation; never return or log it.
      const refresh = await fetch("/api/auth/refresh", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", "X-HiChat-Client": "web" },
        body: "{}",
      });
      const refreshed = await refresh.json().catch(() => null) as {
        success?: boolean;
        data?: { access_token?: string };
      } | null;
      const token = refreshed?.data?.access_token;
      if (!refresh.ok || refreshed?.success !== true || !token) {
        return { authenticated: false, username: null, archiveStatus: refresh.status };
      }

      const identity = await fetch("/api/users/me", {
        credentials: "omit",
        headers: { Authorization: `Bearer ${token}`, "X-HiChat-Client": "web" },
        redirect: "error",
      });
      const identityEnvelope = await identity.json().catch(() => null) as {
        success?: boolean;
        data?: { username?: string };
      } | null;
      if (identity.status !== 200 || identityEnvelope?.success !== true || !identityEnvelope.data?.username) {
        return { authenticated: false, username: null, archiveStatus: identity.status };
      }

      const archive = await fetch(target, {
        credentials: "omit",
        headers: { Authorization: `Bearer ${token}`, "X-HiChat-Client": "web" },
        redirect: "error",
      });
      return {
        authenticated: true,
        username: identityEnvelope.data.username,
        archiveStatus: archive.status,
      };
    }, { id: jobID, expectedOrigin: "http://localhost:3030" });
    expect(peerCheck.authenticated).toBe(true);
    expect(peerCheck.username).toBe(fixture.recipient.username);
    expect([403, 404]).toContain(peerCheck.archiveStatus);
  } finally {
    await Promise.all([ownerContext.close(), recipientContext.close()]);
  }
});
