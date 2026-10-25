const task = await taskSpace("HiChat local acceptance restart 2026-10-23");
const page = task.page("p1");
await page.goto("http://127.0.0.1:15173");
await page.waitForLoadState();
console.log({ taskSpaceId: task.spaceId, page: page.label, url: await page.url(), title: await page.title() });
console.log(await page.snapshot());
