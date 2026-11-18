import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chromium, webkit } from "playwright";

// Independent control: no HiChat modules, stores or application IDB wrappers.
const engine = process.argv.find(arg => arg.startsWith("--browser="))?.slice(10) ?? "chromium";
assert.ok(engine === "chromium" || engine === "webkit");
const server = createServer((_request, response) => {
  response.setHeader("Content-Type", "text/html"); response.end("<title>Disposable native IDB control</title>");
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
try {
  const browser = await ({ chromium, webkit })[engine].launch();
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    let deadline;
    try {
      const result = await Promise.race([
        page.evaluate(async () => {
          const name = `native-idb-control-${crypto.randomUUID()}`;
          const db = await new Promise((resolve, reject) => {
            const request = indexedDB.open(name, 1);
            request.onupgradeneeded = () => {
              const store = request.result.createObjectStore("refs", { keyPath: ["snapshotId", "messageId"] });
              store.createIndex("time", ["snapshotId", "time", "messageId"]);
              store.createIndex("sequence", ["snapshotId", "sequence", "timestamp", "messageId"]);
              store.createIndex("rank", ["snapshotId", "rank"], { unique: true });
            };
            request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
          });
          const run = operation => new Promise((resolve, reject) => {
            const started = performance.now(), tx = db.transaction("refs", "readwrite");
            tx.oncomplete = () => resolve(performance.now() - started);
            tx.onabort = () => reject(tx.error ?? new Error("Native control transaction aborted"));
            for (let i = 0; i < 100; i++) operation(tx.objectStore("refs"), i);
          });
          try {
            const putMs = await run((store, i) => store.put({ snapshotId: "control", messageId: String(i) }));
            const deleteMs = await run((store, i) => store.delete(["control", String(i)]));
            return { requestsPerTransaction: 100, putMs, deleteMs };
          } finally {
            db.close();
            await new Promise((resolve, reject) => {
              const request = indexedDB.deleteDatabase(name);
              request.onsuccess = resolve; request.onerror = () => reject(request.error);
              request.onblocked = () => reject(new Error("Native control cleanup blocked"));
            });
          }
        }),
        new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error("Native control deadline exceeded")), 30_000); }),
      ]);
      console.log(JSON.stringify({ runtime: process.version, platform: process.platform, engine, version: browser.version(), ...result,
        scope: "Single raw native request-throughput control with derived-index schema;not application latency or a physical memory/quota acceptance." }));
    } finally { clearTimeout(deadline); }
  } finally { await browser.close(); }
} finally { await new Promise(resolve => server.close(resolve)); }
