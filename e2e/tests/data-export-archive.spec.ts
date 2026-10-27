import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { removeSyntheticExportArchive } from "../scripts/remove-synthetic-export-archive.js";
import { test, expect } from "@playwright/test";
import {
  dismissOnboardingOverlays,
  loginAsNotificationOwner,
  loginAsNotificationRecipient,
  readChannelNotificationFixture,
  resetChannelNotificationFixture,
} from "./helpers";
import { createOpaqueAttachmentFixture, readExportZipEntries } from "./dataExportArchive.helpers";

const EXPORT_CREATE_PATH = "/api/users/me/data-exports";
const ARCHIVE_READY_TIMEOUT_MS = 45_000;
const HTTP_DOWNLOAD_TIMEOUT_MS = 15_000;

test("owner recreates a missing opaque attachment archive; authenticated peer is denied", async ({ browser }) => {
  // Two bounded preparation windows plus login, JSON/ZIP transfers and peer checks.
  test.setTimeout(180_000);
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
    await dismissOnboardingOverlays(ownerPage);

    await ownerPage.getByRole("button", { name: "Settings", exact: true }).click();
    const settings = ownerPage.getByRole("dialog", { name: "Settings" });
    await expect(settings).toBeVisible();
    await settings.getByRole("button", { name: "Security", exact: true }).click();
    const exportSection = settings.locator('[data-settings-section="data-export"]');
    await expect(exportSection).toBeVisible();

    const createResponsePromise = ownerPage.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === EXPORT_CREATE_PATH && response.request().method() === "POST";
    }, { timeout: HTTP_DOWNLOAD_TIMEOUT_MS });
    await exportSection.getByRole("button", { name: "Prepare a new export", exact: true }).click();
    const createResponse = await createResponsePromise;
    expect(createResponse.status()).toBe(201);
    const created = await createResponse.json() as { success?: boolean; data?: { id?: string } };
    expect(created.success).toBe(true);
    const jobID = created.data?.id;
    expect(jobID).toMatch(/^[a-f0-9]{48}$/);
    if (!jobID) throw new Error("export API did not return a job ID");

    const archiveButton = exportSection.getByRole("button", { name: "Download attachments ZIP", exact: true });
    await expect(archiveButton).toBeVisible({ timeout: ARCHIVE_READY_TIMEOUT_MS });
    const downloadResponsePromise = ownerPage.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === `${EXPORT_CREATE_PATH}/${jobID}/attachments` && response.request().method() === "GET";
    }, { timeout: HTTP_DOWNLOAD_TIMEOUT_MS });
    const downloadPromise = ownerPage.waitForEvent("download", { timeout: HTTP_DOWNLOAD_TIMEOUT_MS });
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

    // Delete only A's verified ZIP from this exact live synthetic run. The
    // application still holds A's ready response, exercising download-time loss.
    expect(removeSyntheticExportArchive(jobID)).toEqual({ deleted: true });
    const missingResponsePromise = ownerPage.waitForResponse(response => {
      const url = new URL(response.url());
      return url.origin === "http://localhost:3030" && url.pathname === `${EXPORT_CREATE_PATH}/${jobID}/attachments` && response.request().method() === "GET";
    }, { timeout: HTTP_DOWNLOAD_TIMEOUT_MS });
    await archiveButton.click();
    expect((await missingResponsePromise).status()).toBe(404);
    await expect(exportSection.getByRole("status")).toBeVisible();
    await expect(exportSection.getByRole("status")).toContainText(/ZIP|archive/i);
    await expect(exportSection.getByRole("status")).toContainText(/JSON/i);
    await expect(archiveButton).toHaveCount(0);

    // Missing binary storage must not remove the separately retained JSON.
    const jsonDownloadPromise = ownerPage.waitForEvent("download", { timeout: HTTP_DOWNLOAD_TIMEOUT_MS });
    await exportSection.getByRole("button", { name: "Download JSON file", exact: true }).click();
    const jsonDownload = await jsonDownloadPromise;
    const jsonPath = await jsonDownload.path();
    if (!jsonPath) throw new Error("synthetic JSON download was not available");
    const accountData = JSON.parse(await readFile(jsonPath, "utf8")) as { account?: { username?: string } };
    expect(accountData.account?.username).toBe(fixture.owner.username);

    // Re-creation is explicit: a new job B is published from retained opaque
    // source bytes; neither a hidden auto-create nor an old response is enough.
    const recreatePromise = ownerPage.waitForResponse(response => {
      const url = new URL(response.url());
      return url.origin === "http://localhost:3030" && url.pathname === EXPORT_CREATE_PATH && response.request().method() === "POST";
    }, { timeout: HTTP_DOWNLOAD_TIMEOUT_MS });
    await exportSection.getByRole("button", { name: "Prepare a new export", exact: true }).click();
    const recreateResponse = await recreatePromise;
    expect(recreateResponse.status()).toBe(201);
    const recreated = await recreateResponse.json() as { data?: { id?: string } };
    const newJobID = recreated.data?.id;
    expect(newJobID).toMatch(/^[a-f0-9]{48}$/);
    expect(newJobID).not.toBe(jobID);
    if (!newJobID) throw new Error("synthetic replacement export has no job ID");
    await expect(archiveButton).toBeVisible({ timeout: ARCHIVE_READY_TIMEOUT_MS });
    const recreatedDownloadResponse = ownerPage.waitForResponse(response => new URL(response.url()).pathname === `${EXPORT_CREATE_PATH}/${newJobID}/attachments` && response.request().method() === "GET", { timeout: HTTP_DOWNLOAD_TIMEOUT_MS });
    const recreatedDownloadPromise = ownerPage.waitForEvent("download", { timeout: HTTP_DOWNLOAD_TIMEOUT_MS });
    await archiveButton.click();
    expect((await recreatedDownloadResponse).status()).toBe(200);
    const recreatedDownload = await recreatedDownloadPromise;
    const recreatedPath = await recreatedDownload.path();
    if (!recreatedPath) throw new Error("replacement synthetic ZIP was not downloaded");
    const recreatedEntries = readExportZipEntries(await readFile(recreatedPath));
    const recreatedManifestBytes = recreatedEntries.get("manifest.json");
    if (!recreatedManifestBytes) throw new Error("replacement synthetic ZIP has no manifest");
    const recreatedManifest = JSON.parse(recreatedManifestBytes.toString("utf8")) as typeof manifest;
    const recreatedItem = recreatedManifest.files?.find(entry => entry.id === opaque.attachmentID && entry.message_id === opaque.messageID);
    expect(recreatedItem?.sha256).toBe(createHash("sha256").update(opaque.expectedBytes).digest("hex"));
    expect(recreatedItem?.path ? recreatedEntries.get(recreatedItem.path) : undefined).toEqual(opaque.expectedBytes);
    await expect(exportSection.getByRole("status")).toHaveCount(0);

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
    }, { id: newJobID, expectedOrigin: "http://localhost:3030" });
    expect(peerCheck.authenticated).toBe(true);
    expect(peerCheck.username).toBe(fixture.recipient.username);
    expect([403, 404]).toContain(peerCheck.archiveStatus);
  } finally {
    await Promise.all([ownerContext.close(), recipientContext.close()]);
  }
});
