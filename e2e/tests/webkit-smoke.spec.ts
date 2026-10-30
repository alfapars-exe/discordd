import { test, expect } from '@playwright/test';

test('public auth screens load without script failures in WebKit', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/login');
  await expect(page.locator('input[type="password"]')).toBeVisible();
  await expect(page.locator('button[type="submit"]')).toBeEnabled();
  await page.goto('/forgot-password');
  // Recovery accepts either a username or email, so its field is type=text.
  await expect(page.locator('input#identifier')).toBeVisible();
  await page.locator('input#identifier').fill('fixture@example.test');
  await expect(page.locator('button[type="submit"]')).toBeEnabled();
  expect(errors).toEqual([]);
});
