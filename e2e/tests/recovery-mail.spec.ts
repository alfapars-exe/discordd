import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { forceEnglish, loginAsCredentials, readTestAccount } from "./helpers";

test("recover the disposable account using the delivered reset link", async ({ page }) => {
  test.skip(process.env.HICHAT_E2E_RECOVERY_MAIL !== "1", "Requires the loopback recovery mail fixture");
  const account = readTestAccount();
  const password = randomBytes(24).toString("hex");
  let resetLink: URL | undefined;
  const mailbox = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const mail = JSON.parse(body);
    const match = mail.html?.match(/href="([^"]+\/reset-password\?token=[a-f0-9]+)"/);
    if (req.method === "POST" && req.url === "/emails" && mail.to?.includes(account.username + "@example.test") && match) {
      resetLink = new URL(match[1]);
    }
    res.writeHead(200, { "Content-Type": "application/json" }).end('{"id":"fixture-delivery"}');
  });
  await new Promise<void>((resolve, reject) => mailbox.once("error", reject).listen(19387, "127.0.0.1", resolve));
  try {
    await forceEnglish(page);
    await page.goto("/forgot-password");
    await page.locator("#identifier").fill(account.username);
    await page.locator('button[type="submit"]').click();
    await expect.poll(() => resetLink?.origin).toBe("http://localhost:3030");
    await page.goto(resetLink!.href);
    await page.locator("#new-password").fill(password);
    await page.locator("#confirm-password").fill(password);
    await page.locator('button[type="submit"]').click();
    await expect(page.getByRole("heading", { name: "Password reset successfully!" })).toBeVisible();
    await loginAsCredentials(page, { username: account.username, password });
  } finally {
    mailbox.closeAllConnections();
    await new Promise<void>(resolve => mailbox.close(() => resolve()));
  }
});
