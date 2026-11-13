import { expectReplyLoadsOriginal, limitReplyHistoryPage } from "./replyNavigation.helpers";
import { expect, test } from "@playwright/test";
import { fixtureApi, composer, dismissOnboardingOverlays, openFreshChannel } from "./helpers";

test("reply preview loads the original message outside the current channel page", async ({ page }) => {
  await openFreshChannel(page);
  const created = page.waitForResponse(response =>
    response.request().method() === "POST" && /\/channels\/[^/]+\/messages$/.test(response.url()));
  await composer(page).fill("Original message outside the tail page");
  await composer(page).press("Enter");
  const response = await created;
  expect(response.ok()).toBe(true);
  const original = (await response.json()).data;
  const reply = await fixtureApi<{ id: string }>(page,
    new URL(response.url()).pathname.slice("/api".length), "POST",
    { content: "Reply at the tail", reply_to_id: original.id });

  // Keep the real tail query and response, but request one row to exercise
  // the page boundary without sending fifty filler messages.
  const endpoint = new URL(response.url()).pathname;
  await limitReplyHistoryPage(page, endpoint);
  await page.reload();
  await expect(composer(page)).toBeVisible();
  await dismissOnboardingOverlays(page);
  await page.locator("button.ch-tree-item", { hasText: "general" }).first().click();
  await expectReplyLoadsOriginal(page, endpoint, reply.id, original.id, "click");
});
