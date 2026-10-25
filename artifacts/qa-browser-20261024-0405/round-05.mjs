const task = await taskSpace(6);
const page = task.page("p1");
await page.click("loc=href:/register", { label: "open test account registration" });
console.log(await page.snapshot());
