import { expect, test, type Page } from "@playwright/test";
import {
  composer, loginAsNotificationOwner, loginAsNotificationRecipient, messageList,
  readChannelNotificationFixture, resetChannelNotificationFixture,
} from "./helpers";

async function openChannel(page: Page, serverName: string) {
  await page.locator("nav.server-rail").getByRole("button", { name: serverName, exact: true }).click();
  await page.locator("button.ch-tree-item").filter({ hasText: "general" }).first().click();
  await expect(composer(page)).toBeVisible();
  await expect(messageList(page)).toBeVisible();
}

const row = (page: Page, text: string) => messageList(page).getByRole("article").filter({ hasText: text });

async function send(page: Page, text: string) {
  await composer(page).fill(text);
  await composer(page).press("Enter");
  await expect(composer(page)).toHaveValue("");
  await expect(row(page, text)).toHaveCount(1);
}

async function edit(page: Page, before: string, after: string) {
  const message = row(page, before);
  await message.hover();
  await message.getByRole("button", { name: "Edit Message", exact: true }).click();
  // Filling the editor replaces the original text, so a locator filtered by
  // that text no longer matches. Only this page has one active message editor.
  const input = messageList(page).locator("textarea.msg-edit-textarea");
  await expect(input).toHaveCount(1);
  await input.fill(after);
  await input.press("Enter");
  await expect(row(page, after)).toHaveCount(1);
  await expect(row(page, before)).toHaveCount(0);
}

async function remove(page: Page, text: string) {
  const message = row(page, text);
  await message.hover();
  await message.getByRole("button", { name: "Delete Message", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete Message", exact: true }).click();
  await expect(row(page, text)).toHaveCount(0);
}

test("two sessions converge after sends overlap an edit and a deletion", async ({ browser }) => {
  const ownerContext = await browser.newContext();
  const memberContext = await browser.newContext();
  try {
    const owner = await ownerContext.newPage();
    const member = await memberContext.newPage();
    await loginAsNotificationOwner(owner);
    // Reuse fixture identities only; this test owns a fresh server/channel.
    await resetChannelNotificationFixture(owner);
    const fixture = readChannelNotificationFixture();
    await loginAsNotificationRecipient(member);
    await Promise.all([openChannel(owner, fixture.serverName), openChannel(member, fixture.serverName)]);
    const stamp = Date.now();
    const original = `original-owner-${stamp}`;
    const revised = `revised-owner-${stamp}`;
    const removed = `removed-member-${stamp}`;
    const duringEdit = `sent-during-edit-${stamp}`;
    const duringDelete = `sent-during-delete-${stamp}`;
    await Promise.all([send(owner, original), send(member, removed)]);
    for (const page of [owner, member]) {
      await expect(row(page, original)).toHaveCount(1);
      await expect(row(page, removed)).toHaveCount(1);
    }
    await Promise.all([edit(owner, original, revised), send(member, duringEdit)]);
    await Promise.all([remove(member, removed), send(owner, duringDelete)]);
    async function expectConverged(page: Page) {
      for (const text of [revised, duringEdit, duringDelete]) await expect(row(page, text)).toHaveCount(1);
      for (const text of [original, removed]) await expect(row(page, text)).toHaveCount(0);
    }
    await Promise.all([expectConverged(owner), expectConverged(member)]);
    // Reload both clients: persistence must agree with the live event stream.
    await Promise.all([owner.reload(), member.reload()]);
    await Promise.all([expect(messageList(owner)).toBeVisible(), expect(messageList(member)).toBeVisible()]);
    await Promise.all([expectConverged(owner), expectConverged(member)]);
  } finally {
    await Promise.all([ownerContext.close(), memberContext.close()]);
  }
});


test("an offline session heals missed sends, edits and deletions before receiving live messages", async ({ browser }) => {
  const ownerContext = await browser.newContext();
  const memberContext = await browser.newContext();
  try {
    const owner = await ownerContext.newPage();
    const member = await memberContext.newPage();
    let memberSockets = 0;
    let closedMemberSockets = 0;
    member.on("websocket", socket => {
      if (new URL(socket.url()).pathname !== "/ws") return;
      memberSockets++;
      socket.on("close", () => { closedMemberSockets++; });
    });
    await loginAsNotificationOwner(owner);
    await resetChannelNotificationFixture(owner);
    const fixture = readChannelNotificationFixture();
    await loginAsNotificationRecipient(member);
    await Promise.all([openChannel(owner, fixture.serverName), openChannel(member, fixture.serverName)]);
    const stamp = Date.now();
    const original = `before-offline-original-${stamp}`;
    const revised = `after-offline-revised-${stamp}`;
    const removed = `removed-while-offline-${stamp}`;
    const missed = [`missed-one-${stamp}`, `missed-two-${stamp}`];
    const live = `live-after-reconnect-${stamp}`;
    await send(owner, original);
    await send(owner, removed);
    for (const text of [original, removed]) await expect(row(member, text)).toHaveCount(1);
    const initialSockets = memberSockets;
    expect(initialSockets).toBeGreaterThan(0);
    await memberContext.setOffline(true);
    await expect.poll(() => member.evaluate(() => navigator.onLine)).toBe(false);
    await expect.poll(() => closedMemberSockets).toBeGreaterThan(0);
    await edit(owner, original, revised);
    await remove(owner, removed);
    for (const text of missed) await send(owner, text);
    // This client missed the actual server events, rather than rendering a
    // page that was never loaded or receiving a synthetic store mutation.
    for (const text of [original, removed]) await expect(row(member, text)).toHaveCount(1);
    for (const text of [revised, ...missed]) await expect(row(member, text)).toHaveCount(0);
    await memberContext.setOffline(false);
    await expect.poll(() => memberSockets).toBeGreaterThan(initialSockets);
    async function expectHealed() {
      for (const text of [revised, ...missed]) await expect(row(member, text)).toHaveCount(1);
      for (const text of [original, removed]) await expect(row(member, text)).toHaveCount(0);
    }
    await expectHealed();
    await send(owner, live);
    await expect(row(member, live)).toHaveCount(1);
    await member.reload();
    await expect(messageList(member)).toBeVisible();
    await expectHealed();
    await expect(row(member, live)).toHaveCount(1);
  } finally {
    await Promise.all([ownerContext.close(), memberContext.close()]);
  }
});
