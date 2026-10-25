const task = await taskSpace(6);
const page = task.page("p1");
console.log({ screenshot: await page.screenshot({ path: "C:/Users/PARS/Desktop/PROJELER/HiChat/discordd/artifacts/qa-browser-20261024-0405/shortcut-help.png" }) });
await page.keyboard.press("Tab");
console.log(await page.evaluate(() => ({ tabContained: document.querySelector("dialog")?.contains(document.activeElement) })));
await page.keyboard.press("Escape");
await page.waitForFunction(() => !document.querySelector("dialog[open]"), undefined, { timeout: 10000 });
console.log(await page.evaluate(() => ({ escaped: !document.querySelector("dialog[open]"), focusReturned: document.activeElement?.getAttribute("aria-label") === "Ayarlar" })));
console.log(await page.snapshot());
