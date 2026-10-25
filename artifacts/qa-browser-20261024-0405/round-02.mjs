const task = await taskSpace("hichat-acceptance-20261024-0405");
console.log({ spaceId: task.spaceId });
const page = task.page("p1");
await page.goto("http://127.0.0.1:15173/login");
console.log(await page.snapshot());
