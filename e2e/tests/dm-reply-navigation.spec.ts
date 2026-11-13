import { expect, test } from "@playwright/test";
import { dismissOnboardingOverlays, loginAsNotificationOwner, loginAsNotificationRecipient } from "./helpers";

test("a DM reply loads the original from outside the current history page", async ({ page, browser }) => {
  await loginAsNotificationOwner(page);
  const peerContext = await browser.newContext();
  try {
    const peer = await peerContext.newPage();
    await loginAsNotificationRecipient(peer);
    const peerId = await peer.evaluate(async () => {
      const path = "/src/stores/authStore.ts";
      return (await import(path)).useAuthStore.getState().user.id as string;
    });
    const { channelId, originalId } = await page.evaluate(async peerId => {
      const path = "/src/api/dm.ts";
      const api = await import(path);
      const channel = await api.createDMChannel(peerId);
      if (!channel.success) throw new Error("Could not create the fixture DM");
      const channelId: string = channel.data.id;
      if (channel.data.e2ee_enabled) {
        const toggle = await api.toggleDME2EE(channelId, false);
        if (!toggle.success) throw new Error("Could not prepare plaintext fixture");
      }
      const original = await api.sendDMMessage(channelId, "Original E2E DM");
      if (!original.success) throw new Error("Could not send the original DM: " + original.error);
      return { channelId, originalId: original.data.id as string };
    }, peerId);
    const replyId = await peer.evaluate(async ({channelId, originalId}) => {
      const path = "/src/api/dm.ts";
      const api = await import(path);
      const channels = await api.listDMChannels();
      if (channels.data?.find((ch: {id: string}) => ch.id === channelId)?.status === "pending") {
        const accepted = await api.acceptDMRequest(channelId);
        if (!accepted.success) throw new Error("Could not accept the fixture DM");
      }
      const reply = await api.sendDMMessage(channelId, "Reply E2E DM", undefined, originalId);
      if (!reply.success) throw new Error("Could not send the reply: " + reply.error);
      return reply.data.id as string;
    }, {channelId, originalId});
    const endpoint = "/api/dms/" + channelId + "/messages";
    await page.route(url => url.pathname === endpoint && !["before", "after", "around"].some(key => url.searchParams.has(key)), route => {
      const url = new URL(route.request().url());
      url.searchParams.set("limit", "1");
      return route.continue({url: url.href});
    });
    await page.reload();
    await dismissOnboardingOverlays(page);
    await page.evaluate(async channelId => {
      const path = "/src/stores/uiStore.ts";
      (await import(path)).useUIStore.getState().openTab(channelId, "dm", "E2E peer");
    }, channelId);
    const preview = page.locator(`#msg-${replyId} .msg-reply-preview`);
    await expect(preview).toBeVisible();
    const target = page.locator(`#msg-${originalId}`);
    await expect(target).toHaveCount(0);
    const around = page.waitForResponse(response => new URL(response.url()).pathname === endpoint &&
      new URL(response.url()).searchParams.get("around") === originalId);
    await preview.click();
    expect((await around).ok()).toBe(true);
    await expect(target).toBeInViewport();
    await expect(target).toHaveClass(/msg-highlight/);
  } finally {
    await peerContext.close();
  }
});
