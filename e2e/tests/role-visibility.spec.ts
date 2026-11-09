import { expect, test, type Page } from "@playwright/test";
import { dismissOnboardingOverlays, loginAsNotificationOwner, loginAsNotificationRecipient, readChannelNotificationFixture } from "./helpers";

async function api<T>(page: Page, path: string, method = "GET", body?: unknown): Promise<T> {
  return page.evaluate(async ({ path, method, body }) => {
    // Use the authenticated Vite app session without extracting credentials.
    const modulePath = "/src/api/client.ts";
    const { apiClient } = await import(modulePath);
    const result = await apiClient(path, { method, body });
    if (!result.success) throw Error(method + " " + path + " HTTP " + result.status + " " + result.error);
    return result.data;
  }, { path, method, body });
}

test("channel tree follows role grants and revocations in two authenticated sessions", async ({ browser }) => {
  const owner = await browser.newPage();
  const member = await browser.newPage();
  function channelUpdateTopics(page: Page) {
    const topics: string[] = [];
    page.on("websocket", socket => socket.on("framereceived", ({ payload }) => {
      try {
        const event = JSON.parse(String(payload));
        if (event.op === "channel_update" && typeof event.d?.topic === "string") topics.push(event.d.topic);
      } catch { /* Binary frames and unrelated protocols carry no channel update here. */ }
    }));
    return topics;
  }
  const ownerTopics = channelUpdateTopics(owner);
  const memberTopics = channelUpdateTopics(member);
  const fixture = readChannelNotificationFixture();
  const root = "/servers/" + fixture.serverId;
  await loginAsNotificationOwner(owner);
  await loginAsNotificationRecipient(member);
  const user = await api<{ id: string }>(member, "/users/me");
  const roles = await api<{ id: string; is_default: boolean }[]>(owner, root + "/roles");
  const everyone = roles.find(role => role.is_default)!;
  const extra = await api<{ id: string }>(owner, root + "/roles", "POST", { name: "Visibility test", color: "#888888", permissions: 0 });
  const voice = await api<{ id: string }>(owner, root + "/channels", "POST", { name: "fixture-voice-private", type: "voice" });
  const ids = [fixture.privateChannelId, voice.id];
  const names = ["fixture-private", "fixture-voice-private"];
  const view = 4096;
  await api(owner, root + "/channels/" + voice.id + "/permissions/" + everyone.id, "PUT", { deny: view, allow: 0 });
  for (const id of ids) {
    await api(owner, root + "/channels/" + id + "/permissions/" + extra.id, "PUT", { allow: view, deny: 0 });
  }
  async function open(page: Page) {
    await page.locator("nav.server-rail").getByRole("button", { name: new RegExp(fixture.serverName) }).click();
    await expect(page.locator("button.ch-tree-item").filter({hasText:"general"}).first()).toBeVisible();
  }
  async function check(page: Page, visible: boolean) {
    const groups = await api<{ channels: { id: string }[] }[]>(page, root + "/channels");
    const listed = groups.flatMap(group => group.channels.map(channel => channel.id));
    for (const [i, id] of ids.entries()) {
      expect(listed.includes(id)).toBe(visible);
      await expect(page.getByRole("complementary").getByRole("button", {name: new RegExp(names[i] + "$")})).toHaveCount(visible ? 1 : 0);
    }
  }
  await open(owner);
  await open(member);
  await check(owner, true);
  await check(member, false);
  const secret = "private topic " + Date.now();
  const barrier = "public topic " + Date.now();
  await api(owner, root + "/channels/" + fixture.privateChannelId, "PATCH", {topic: secret});
  await expect.poll(() => ownerTopics.includes(secret)).toBe(true);
  await api(owner, root + "/channels/" + fixture.channelId, "PATCH", {topic: barrier});
  await expect.poll(() => memberTopics.includes(barrier)).toBe(true);
  expect(memberTopics).not.toContain(secret);
  await api(owner, root + "/channels/" + fixture.privateChannelId + "/messages");
  await expect(api(member, root + "/channels/" + fixture.privateChannelId + "/messages")).rejects.toThrow(/HTTP 403/);
  const assignments = root + "/members/" + user.id + "/roles";
  await api(owner, assignments, "PATCH", { role_ids: [everyone.id, extra.id] });
  await check(member, true);
  await api(owner, assignments, "PATCH", { role_ids: [everyone.id] });
  await check(member, false);
  await member.reload();
  await dismissOnboardingOverlays(member);
  await open(member);
  await check(member, false);
  // Reuse the owner's browser storage and the application's logout flow.
  await owner.evaluate(async () => {
    const modulePath = "/src/stores/authStore.ts";
    const { useAuthStore } = await import(modulePath);
    await useAuthStore.getState().logout();
  });
  await loginAsNotificationRecipient(owner);
  await open(owner);
  await check(owner, false);
  await owner.close();
  await member.close();
});
