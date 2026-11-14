import { test, expect } from '@playwright/test';

test('login and password recovery support keyboard navigation without script failures', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/login');
  // A fresh context can honor refresh Retry-After before showing signed-out UI.
  // Wait for that actual form, matching the shared login helper readiness gate.
  await expect(page.locator('input[type="password"]')).toBeVisible({ timeout: 90_000 });
  await expect(page.locator('button[type="submit"]')).toBeEnabled();
  const recoveryLink = page.locator('a[href="/forgot-password"]');
  await recoveryLink.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/forgot-password$/);
  // Recovery accepts either a username or email, so its field is type=text.
  await expect(page.locator('input#identifier')).toBeVisible();
  await page.locator('input#identifier').fill('fixture@example.test');
  await expect(page.locator('button[type="submit"]')).toBeEnabled();
  await page.keyboard.press('Tab');
  await expect(page.locator('button[type="submit"]')).toBeFocused();
  const loginLink = page.locator('a[href="/login"]');
  await loginLink.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('input[type="password"]')).toBeVisible();
  expect(errors).toEqual([]);
});
