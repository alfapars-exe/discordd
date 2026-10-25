const task = await taskSpace(6);
const page = task.page("p1");
await page.keyboard.press("Tab");
console.log(await page.evaluate(() => ({ tabContained: document.querySelector("dialog")?.contains(document.activeElement) })));
await page.keyboard.press("Escape");
await page.waitForFunction(() => !document.querySelector("dialog[open]"), undefined, { timeout: 10000 });
console.log(await page.evaluate(() => ({ escaped: !document.querySelector("dialog[open]"), focusReturned: document.activeElement?.getAttribute("aria-label") === "Ayarlar" })));
console.log(await page.snapshot());
