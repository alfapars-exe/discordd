import { test, expect, type Page } from "@playwright/test";
import {
  composer,
  loginAsNotificationOwner,
  loginAsNotificationRecipient,
  messageList,
  channelNotificationQueueState,
  readChannelNotificationFixture,
  resetChannelNotificationFixture,
} from "./helpers";

const PREFERENCE_PATH = "/api/users/me/preferences";
const NOTIFICATION_LIST_PATH = "/api/users/me/notifications";

async function openFixtureChannel(page: Page, serverName: string, channelName: string): Promise<void> {
  await page.getByRole("button", { name: serverName, exact: true }).click();
  const channel = page.locator("button.ch-tree-item", { hasText: channelName }).first();
  await expect(channel).toBeVisible({ timeout: 15_000 });
  await channel.click();
  await expect(composer(page)).toBeVisible({ timeout: 15_000 });
  await expect(messageList(page)).toBeVisible({ timeout: 15_000 });
}

async function sendMessage(page: Page, text: string): Promise<void> {
  await composer(page).fill(text);
  await composer(page).press("Enter");
  await expect(messageList(page).getByText(text, { exact: true })).toBeVisible({ timeout: 15_000 });
}

async function setChannelNoticePreference(page: Page, enabled: boolean): Promise<void> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await expect(settings).toBeVisible();
  await settings.getByRole("button", { name: "Notifications", exact: true }).click();
  const toggle = settings.getByRole("checkbox", { name: "Channel message notices", exact: true });
  await expect(toggle).toBeAttached();
  if ((await toggle.isChecked()) !== enabled) {
    const saved = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === PREFERENCE_PATH
        && response.request().method() === "PATCH"
        && response.ok();
    });
    // The checkbox is visually hidden (width/height 0); click its visible
    // switch label, which is the control a user actually operates.
    await settings.locator("label.vs-switch").filter({ has: toggle }).click();
    await saved;
    await expect(toggle).toBeChecked({ checked: enabled });
  }
  await page.keyboard.press("Escape");
  await expect(settings).toBeHidden();
}

async function refreshNotificationRows(page: Page) {
  const popover = page.getByRole("dialog", { name: "Notifications" });
  const bell = page.getByRole("button", { name: "Notifications", exact: true });
  if (await popover.isVisible().catch(() => false)) {
    await bell.click();
    await expect(popover).toBeHidden();
  }
  const loaded = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === NOTIFICATION_LIST_PATH
      && response.request().method() === "GET"
      && response.ok();
  });
  await bell.click();
  await expect(popover).toBeVisible();
  await loaded;
  // The bell panel is only the entry point. The actual Notifications screen
  // is a tab/container, not a dialog; assert the full-view UI used by users.
  await popover.getByRole("button", { name: "View all", exact: true }).click();
  const notificationsView = page.locator(".inbox-view").filter({
    has: page.getByRole("heading", { name: "Notifications", exact: true }),
  });
  await expect(notificationsView).toBeVisible();
  return notificationsView.locator(".notif-row");
}

async function expectQueueJobProcessed(messageMarker: string): Promise<void> {
  await expect.poll(
    () => channelNotificationQueueState(messageMarker),
    { timeout: 15_000, intervals: [100, 200, 400, 800] },
  ).toEqual({ messages: 1, pendingJobs: 0 });
}

test("channel notice opt-in, opt-out, channel mute, and private-channel ACL are enforced", async ({ browser }) => {
  const recipientContext = await browser.newContext();
  const ownerContext = await browser.newContext();
  const recipientPage = await recipientContext.newPage();
  const ownerPage = await ownerContext.newPage();

  try {
    await loginAsNotificationOwner(ownerPage);
    // On CI retry, start from a new disposable fixture server. Deleting this
    // synthetic server cascades its messages, queue jobs, and notifications.
    await resetChannelNotificationFixture(ownerPage);
    const fixture = readChannelNotificationFixture();
    await loginAsNotificationRecipient(recipientPage);
    await setChannelNoticePreference(recipientPage, false);

    const optOutMarker = `opted-out-${Date.now()}`;
    await openFixtureChannel(ownerPage, fixture.serverName, "general");
    await sendMessage(ownerPage, optOutMarker);
    await expectQueueJobProcessed(optOutMarker);
    let rows = await refreshNotificationRows(recipientPage);
    await expect(rows).toHaveCount(0);
    await expect(recipientPage.getByText("No notifications", { exact: true })).toBeVisible();

    await setChannelNoticePreference(recipientPage, true);
    const allowedMarker = `allowed-${Date.now()}`;
    await sendMessage(ownerPage, allowedMarker);
    await expectQueueJobProcessed(allowedMarker);
    rows = await refreshNotificationRows(recipientPage);
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("sent a channel message");
    // Channel notices carry metadata only; the message body never appears in
    // the notification row or preview.
    await expect(rows.first()).not.toContainText(allowedMarker);

    const mutedMarker = `muted-${Date.now()}`;
    await openFixtureChannel(ownerPage, fixture.serverName, "fixture-muted");
    await sendMessage(ownerPage, mutedMarker);
    // Read the disposable queue directly, so a pending retry cannot be
    // mistaken for successful mute suppression.
    await expectQueueJobProcessed(mutedMarker);
    rows = await refreshNotificationRows(recipientPage);
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).not.toContainText(mutedMarker);

    const privateMarker = `private-${Date.now()}`;
    await openFixtureChannel(ownerPage, fixture.serverName, "fixture-private");
    await sendMessage(ownerPage, privateMarker);
    await expectQueueJobProcessed(privateMarker);
    rows = await refreshNotificationRows(recipientPage);
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).not.toContainText(privateMarker);

    await setChannelNoticePreference(recipientPage, false);
    const optOutAgainMarker = `opted-out-again-${Date.now()}`;
    await openFixtureChannel(ownerPage, fixture.serverName, "general");
    await sendMessage(ownerPage, optOutAgainMarker);
    await expectQueueJobProcessed(optOutAgainMarker);
    rows = await refreshNotificationRows(recipientPage);
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).not.toContainText(optOutAgainMarker);
  } finally {
    await Promise.all([recipientContext.close(), ownerContext.close()]);
  }
});
