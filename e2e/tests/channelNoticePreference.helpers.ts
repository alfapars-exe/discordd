import { expect, type Page } from "@playwright/test";

const PREFERENCE_PATH = "/api/users/me/preferences";

export async function setChannelNoticePreference(page: Page, enabled: boolean): Promise<void> {
  const opener = page.getByRole("button", { name: "Settings", exact: true });
  await opener.focus();
  await opener.press("Enter");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await expect(settings).toBeVisible();
  await expect.poll(() => settings.evaluate(dialog => dialog.contains(document.activeElement))).toBe(true);
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
    const switchLabel = toggle.locator("xpath=..");
    await expect(switchLabel).toHaveClass(/\bvs-switch\b/);
    await switchLabel.click();
    await saved;
    await expect(toggle).toBeChecked({ checked: enabled });
  }
  await page.keyboard.press("Escape");
  await expect(settings).toBeHidden();
  await expect(opener).toBeFocused();
}

