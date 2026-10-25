const task = await taskSpace(6);
const page = task.page("p1");
await page.waitForSelector("input", { state: "visible", timeout: 15000 });
console.log(await page.snapshot());
