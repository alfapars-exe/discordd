const task = await taskSpace(15);
const page = task.page("p1");
await page.waitForTimeout(2500);
console.log(await page.snapshot({ scope: "full_page" }));
