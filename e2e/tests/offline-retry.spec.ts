import { expect, test } from "@playwright/test";
import { composer, messageList, openFreshChannel } from "./helpers";

test("an offline send preserves its draft and retries online without duplicates", async ({ page }) => {
  await openFreshChannel(page);
  const draft = `offline-retry-${Date.now()}`;
  const rows = () => messageList(page).getByRole("article").filter({ hasText: draft });
  try {
    await page.context().setOffline(true);
    await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);
    await composer(page).fill(draft);
    await composer(page).press("Enter");
    await expect(page.getByRole("alert").filter({ hasText: /Message couldn't be sent/i })).toBeVisible({ timeout: 20_000 });
    await expect(composer(page)).toHaveValue(draft);
    await expect(rows()).toHaveCount(0);
  } finally {
    await page.context().setOffline(false);
  }
  await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(true);
  await composer(page).press("Enter");
  await expect(composer(page)).toHaveValue("");
  await expect(rows()).toHaveCount(1);
  await page.reload();
  await expect(rows()).toHaveCount(1);
});
