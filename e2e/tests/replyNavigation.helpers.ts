import { expect, type Page } from "@playwright/test";

// Change only the initial page size. All history responses come from the server.
export async function limitReplyHistoryPage(page: Page, endpoint: string) {
  await page.route(url => url.pathname === endpoint &&
    !["before", "after", "around"].some(key => url.searchParams.has(key)), route => {
    const url = new URL(route.request().url());
    url.searchParams.set("limit", "1");
    return route.continue({ url: url.href });
  });
}

export async function expectReplyLoadsOriginal(page: Page, endpoint: string, replyId: string, originalId: string) {
  const preview = page.locator(`#msg-${replyId} .msg-reply-preview`);
  await expect(preview).toBeVisible();
  const target = page.locator(`#msg-${originalId}`);
  await expect(target).toHaveCount(0);
  const around = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === endpoint && url.searchParams.get("around") === originalId;
  });
  await preview.click();
  expect((await around).ok()).toBe(true);
  await expect(target).toBeInViewport();
  await expect(target).toHaveClass(/msg-highlight/);
}
