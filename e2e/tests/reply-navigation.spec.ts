import { expectReplyLoadsOriginal, limitReplyHistoryPage } from "./replyNavigation.helpers";
import { expect, test } from "@playwright/test";
import { composer, dismissOnboardingOverlays, openFreshChannel } from "./helpers";

test("reply preview loads the original message outside the current channel page", async ({ page }) => {
  await openFreshChannel(page);
  const created = page.waitForResponse(response =>
    response.request().method() === "POST" && /\/channels\/[^/]+\/messages$/.test(response.url()));
  await composer(page).fill("Original message outside the tail page");
  await composer(page).press("Enter");
  const response = await created;
  expect(response.ok()).toBe(true);
  const original = (await response.json()).data;
  const reply = await page.evaluate(async ({ original, endpoint }) => {
    const modulePath = "/src/api/client.ts";
    const { apiClient } = await import(modulePath);
    const result = await apiClient(endpoint, {
      method: "POST", body: { content: "Reply at the tail", reply_to_id: original },
    });
    if (!result.success) throw new Error("Reply fixture creation failed");
    return result.data.id as string;
  }, { original: original.id, endpoint: new URL(response.url()).pathname.slice("/api".length) });

  // Keep the real tail query and response, but request one row to exercise
  // the page boundary without sending fifty filler messages.
  const endpoint = new URL(response.url()).pathname;
  await limitReplyHistoryPage(page, endpoint);
  await page.reload();
  await expect(composer(page)).toBeVisible();
  await dismissOnboardingOverlays(page);
  await page.locator("button.ch-tree-item", { hasText: "general" }).first().click();
  await expectReplyLoadsOriginal(page, endpoint, reply, original.id);
});
