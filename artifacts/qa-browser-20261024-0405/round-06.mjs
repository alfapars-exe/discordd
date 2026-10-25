const task = await taskSpace(6);
const page = task.page("p1");
await page.waitForURL("**/register", { timeout: 10000 });
console.log(await page.snapshot());
