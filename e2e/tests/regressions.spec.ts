/**
 * regressions.spec.ts — pins three fixes that landed on feat/audit-hardening.
 *
 * Each test names the behaviour it locks in and asserts the thing that would
 * actually have been wrong before the fix, not a proxy for it.
 */

import { test, expect } from "@playwright/test";
import {
  composer,
  expectImageActuallyLoaded,
  messageList,
  openFreshChannel,
  writeDisallowedFixture,
  writePngFixture,
} from "./helpers";

test.beforeEach(async ({ page }) => {
  await openFreshChannel(page);
});

/**
 * Regression 1 — image attachments survive the media-cookie auth path.
 *
 * MessageAttachments.tsx's PlaintextAttachment used to latch `imgFailed` on the
 * FIRST onError, so a single stale-cookie 401 degraded the tile to a generic
 * file card for the life of the render even after the next API call had already
 * refreshed the cookie. The fix retries once behind ensureFreshToken().
 *
 * The assertion has to be naturalWidth > 0: an <img> that 401s is still present
 * and still "visible" to Playwright, so presence proves nothing.
 */
test("image attachment renders as a loaded <img>, not a file card", async ({ page }) => {
  const stream = messageList(page);
  const filename = `regression-preview-${Date.now()}.png`;
  const pngPath = writePngFixture(filename);

  await page.locator('input[type="file"]').first().setInputFiles(pngPath);
  await composer(page).click();
  await composer(page).press("Enter");

  const img = stream.getByRole("img", { name: filename });
  await expect(img).toBeVisible({ timeout: 20_000 });

  await expectImageActuallyLoaded(page, `img[alt="${filename}"]`);

  // The degraded state is a .msg-attachment-file card. Assert we never fell
  // back to it for this attachment.
  await expect(
    stream.locator(".msg-attachment-file", { hasText: filename }),
  ).toHaveCount(0);
});

/**
 * Regression 2 — upload partition surfaces rejections instead of swallowing them.
 *
 * utils/fileValidation.ts splits a selection into { valid, rejected } and
 * MessageInput.tsx routes `rejected` through useAttachmentRejectionToast. The
 * bug this pins (A1, "attachments sometimes disappear") was rejected files
 * being dropped silently, so the user saw a short message with no explanation.
 *
 * Selecting one allowed PNG plus one disallowed .bin must do BOTH things: post
 * the message with exactly one attachment, and toast the rejection.
 */
test("mixed upload posts the valid file and toasts the rejected one", async ({ page }) => {
  const stream = messageList(page);
  const stamp = Date.now();
  const okName = `partition-ok-${stamp}.png`;
  const badName = `partition-bad-${stamp}.bin`;

  await page
    .locator('input[type="file"]')
    .first()
    .setInputFiles([writePngFixture(okName), writeDisallowedFixture(badName)]);

  // Rejection toast fires at selection time, before any send.
  const rejectionToast = page.getByRole("alert").filter({ hasText: badName });
  await expect(rejectionToast).toBeVisible({ timeout: 10_000 });
  await expect(rejectionToast).toContainText(/File type not allowed/i);

  const marker = `partition check ${stamp}`;
  await composer(page).fill(marker);
  await composer(page).press("Enter");

  // Scope the count to the row carrying our marker text. MessageList stamps
  // every virtual row with id="msg-<id>", which is stable across the compact
  // and full render modes.
  const row = stream.locator("[id^='msg-']").filter({ hasText: marker }).first();
  await expect(row).toBeVisible({ timeout: 20_000 });

  // Exactly one attachment made it through — the PNG, not the .bin. Counting
  // direct children matters: an image attachment renders as <a><img/></a>, so
  // matching `img, a` would double-count the single tile.
  await expect(row.locator(".msg-attachments > *")).toHaveCount(1);
  await expect(row.getByRole("img", { name: okName })).toBeVisible();
  await expect(row.getByText(badName)).toHaveCount(0);
});

/**
 * Regression 3 — a failed send keeps the user's draft.
 *
 * messageStore.sendMessage returns false on failure, and MessageInput only
 * calls resetInputAfterSend() when it returns true. Losing the typed text on a
 * flaky network was the reported symptom. sendWithRetryAndToast surfaces the
 * chat:sendFailed toast.
 *
 * A 500 (not an aborted request) is used deliberately: shouldRetry() only
 * retries `isNetworkError`, so a deterministic HTTP error fails fast instead of
 * burning the helper's 1.5s retry delay.
 */
test("failed send shows an error toast and preserves the composer draft", async ({ page }) => {
  const draft = `draft that must survive ${Date.now()}`;

  await page.route("**/api/servers/*/channels/*/messages", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ success: false, error: "e2e injected failure" }),
    });
  });

  await composer(page).fill(draft);
  await composer(page).press("Enter");

  await expect(
    page.getByRole("alert").filter({ hasText: /Message couldn't be sent/i }),
  ).toBeVisible({ timeout: 15_000 });

  // The draft is still in the textarea, ready to retry.
  await expect(composer(page)).toHaveValue(draft);

  // And nothing was optimistically left in the stream.
  await expect(messageList(page).getByText(draft, { exact: false })).toHaveCount(0);
});
