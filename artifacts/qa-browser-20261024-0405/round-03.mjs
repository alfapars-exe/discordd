const task = await taskSpace(6);
const page = task.page("p1");
await page.goto("http://127.0.0.1:15173/login");
console.log(await page.snapshot());
