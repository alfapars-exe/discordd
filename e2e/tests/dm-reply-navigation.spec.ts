import { expectReplyLoadsOriginal, limitReplyHistoryPage } from "./replyNavigation.helpers";
import { expect, test } from "@playwright/test";
import { fixtureApi, dismissOnboardingOverlays, loginAsNotificationOwner, loginAsNotificationRecipient } from "./helpers";

test("a DM reply loads the original from outside the current history page", async ({ page, browser }) => {
  await loginAsNotificationOwner(page);
  const peerContext = await browser.newContext();
  try {
    const peer = await peerContext.newPage();
    await loginAsNotificationRecipient(peer);
    const peerUser = await fixtureApi<{ id: string; username: string; display_name?: string }>(peer, "/users/me");
    const channel = await fixtureApi<{ id: string; e2ee_enabled: boolean }>(page, "/dms", "POST", { user_id: peerUser.id });
    const channelId = channel.id;
    if (channel.e2ee_enabled) {
      await fixtureApi(page, `/dms/channels/${channelId}/e2ee`, "PATCH", { enabled: false });
    }
    const original = await fixtureApi<{ id: string }>(page, `/dms/${channelId}/messages`, "POST", { content: "Original E2E DM" });
    const originalId = original.id;
    const channels = await fixtureApi<{ id: string; status: string }[]>(peer, "/dms");
    if (channels.find(item => item.id === channelId)?.status === "pending") {
      await fixtureApi(peer, `/dms/channels/${channelId}/accept`, "POST");
    }
    const reply = await fixtureApi<{ id: string }>(peer, `/dms/${channelId}/messages`, "POST", {
      content: "Reply E2E DM", reply_to_id: originalId,
    });
    const replyId = reply.id;
    const endpoint = "/api/dms/" + channelId + "/messages";
    await limitReplyHistoryPage(page, endpoint);
    const loadedChannels = page.waitForResponse(response =>
      new URL(response.url()).pathname === "/api/dms"
      && response.request().method() === "GET");
    await page.reload();
    const listed = await loadedChannels;
    expect(listed.ok()).toBe(true);
    const listedChannels = (await listed.json()).data as { id: string }[];
    expect(listedChannels.some(item => item.id === channelId)).toBe(true);
    await dismissOnboardingOverlays(page);
    await page.getByRole("complementary").getByRole("button").filter({ hasText: peerUser.display_name || peerUser.username }).first().click();
    await expectReplyLoadsOriginal(page, endpoint, replyId, originalId, "keyboard");
  } finally {
    await peerContext.close();
  }
});
