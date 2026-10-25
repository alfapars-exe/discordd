const task = await taskSpace(6);
const page = task.page("p1");
await page.click("@51", { label: "defer desktop download prompt" });
await page.click("text=Anladım!", { label: "dismiss app welcome message" });
await page.focus('button[aria-label="Ayarlar"]');
await page.keyboard.press("Control+/");
await page.waitForSelector("dialog[open]", { state: "visible", timeout: 10000 });
console.log(await page.evaluate(() => ({ modal: !!document.querySelector("dialog:modal"), focusedInDialog: document.querySelector("dialog")?.contains(document.activeElement), overflow: document.documentElement.scrollWidth > innerWidth })));
console.log(await page.snapshot());
