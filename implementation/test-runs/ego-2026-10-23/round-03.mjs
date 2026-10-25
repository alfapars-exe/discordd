const task = await taskSpace(15);
const page = task.page("p1");
await page.click("@8", { label: "open login" });
await page.waitForURL(/\/login/);
console.log(await page.snapshot());
