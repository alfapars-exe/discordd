const task = await taskSpace(15);
const page = task.page("p1");
await page.click("@22", { label: "open registration" });
await page.waitForURL(/\/register/);
console.log(await page.snapshot());
