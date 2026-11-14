import { expect, test, type Page } from "@playwright/test";
import { dismissOnboardingOverlays, fixtureApi, loginAsNotificationOwner, loginAsNotificationRecipient } from "./helpers";
import { readChannelNoticePreference, setChannelNoticePreference } from "./channelNoticePreference.helpers";

type Preferences = { user_id: string; data: { notifications?: { channelMessageNotifications?: boolean } } };
async function expectPreference(page: Page, userId: string, enabled: boolean) {
  const preferences = await fixtureApi<Preferences>(page, "/users/me/preferences");
  expect(preferences.user_id).toBe(userId);
  expect(preferences.data.notifications?.channelMessageNotifications).toBe(enabled);
  expect(await readChannelNoticePreference(page)).toBe(enabled);
}
async function logout(page: Page) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("dialog", { name: "Settings" }).getByRole("button", { name: "Log Out", exact: true }).click();
  await expect(page).toHaveURL(/\/login/);
}

test("account preferences stay isolated across sessions, reloads and A/B/A switching", async ({ browser }) => {
  test.skip(process.env.HICHAT_E2E_PREFERENCE_ISOLATION !== "1", "Owns a separate disposable database and identities");
  const ownerContext = await browser.newContext();
  const memberContext = await browser.newContext();
  try {
    const owner = await ownerContext.newPage();
    const member = await memberContext.newPage();
    await loginAsNotificationOwner(owner);
    await loginAsNotificationRecipient(member);
    const ownerUser = await fixtureApi<{ id: string }>(owner, "/users/me");
    const memberUser = await fixtureApi<{ id: string }>(member, "/users/me");
    expect(ownerUser.id).not.toBe(memberUser.id);
    for (const [page, user] of [[owner, ownerUser], [member, memberUser]] as const) {
      await fixtureApi(page, "/users/me/preferences", "PATCH", { expected_user_id: user.id, data: { notifications: { channelMessageNotifications: false } } });
      await page.reload();
      await dismissOnboardingOverlays(page);
      await expectPreference(page, user.id, false);
    }
    await setChannelNoticePreference(owner, true);
    await expectPreference(owner, ownerUser.id, true);
    await member.reload();
    await dismissOnboardingOverlays(member);
    await expectPreference(member, memberUser.id, false);

    await setChannelNoticePreference(member, true);
    await expectPreference(member, memberUser.id, true);
    await setChannelNoticePreference(member, false);
    await expectPreference(member, memberUser.id, false);
    await owner.reload();
    await dismissOnboardingOverlays(owner);
    await expectPreference(owner, ownerUser.id, true);

    // Reuse A's browser storage: B must not inherit A's enabled setting.
    await logout(owner);
    await loginAsNotificationRecipient(owner);
    await expectPreference(owner, memberUser.id, false);
    await logout(owner);
    await loginAsNotificationOwner(owner);
    await expectPreference(owner, ownerUser.id, true);
  } finally {
    await Promise.all([ownerContext.close(), memberContext.close()]);
  }
});
