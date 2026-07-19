/**
 * golden-path.spec.ts — the load-bearing happy path.
 *
 * Register and login happen in auth.setup.ts (see the rate-limit rationale
 * there); this spec picks up authenticated and covers:
 *
 *   create server → open the #general text channel → send a message →
 *   upload a PNG → assert the attachment actually decoded.
 *
 * The final assertion is the reason this test exists. /api/uploads/* is
 * auth-gated and an <img> tag cannot carry an Authorization header, so inline
 * attachments authenticate with the hichat_media cookie. A regression there
 * still leaves an <img> in the DOM, so `toBeVisible()` would pass while every
 * image in the app rendered broken — naturalWidth > 0 is what actually catches it.
 */

import { test, expect } from "@playwright/test";
import {
  composer,
  expectImageActuallyLoaded,
  messageList,
  openFreshChannel,
  writePngFixture,
} from "./helpers";

test.describe("golden path", () => {
  test("create server → open channel → send message → upload PNG renders", async ({ page }) => {
    // Logs in, creates a server through the real wizard, and leaves its
    // (empty) #general channel open with the composer ready.
    await openFreshChannel(page);

    const stream = messageList(page);
    await expect(stream).toBeVisible();

    // ─── Send a text message ───────────────────────────────────────────
    const messageText = `hello from playwright ${Date.now()}`;
    await composer(page).fill(messageText);
    await composer(page).press("Enter");

    await expect(stream.getByText(messageText, { exact: false })).toBeVisible({
      timeout: 15_000,
    });

    // ─── Upload a PNG attachment ───────────────────────────────────────
    const pngPath = writePngFixture("golden-path.png");

    // The file input is `display: none` and driven by the paperclip button.
    // setInputFiles writes to it directly, which fires the same change event
    // the picker would.
    await page.locator('input[type="file"]').first().setInputFiles(pngPath);

    // FilePreview renders a thumbnail in the composer; the send button enables
    // on files.length > 0 even with empty text.
    await composer(page).click();
    await composer(page).press("Enter");

    // MessageAttachments renders <img alt={filename}>.
    const uploaded = stream.getByRole("img", { name: "golden-path.png" });
    await expect(uploaded).toBeVisible({ timeout: 20_000 });

    await expectImageActuallyLoaded(page, 'img[alt="golden-path.png"]');
  });
});
