import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "../../client/node_modules/vite/dist/node/index.js";

const root = fileURLToPath(new URL("../../client/", import.meta.url));
const server = await createServer({ root, configFile: false, logLevel: "error", server: { host: "127.0.0.1", port: 0 } });
await server.listen();
try {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route("**/benchmark.html", route => route.fulfill({ contentType: "text/html", body: "<title>Search benchmark</title>" }));
    await page.goto(new URL("benchmark.html", server.resolvedUrls.local[0]).href);
    console.log("Chromium", browser.version());
    for (const size of [1000, 10000, 50000]) {
      const report = await page.evaluate(async size => {
        const { publishAuthOwnerChange } = await import("/src/api/authSessionEvents.ts");
        const { openScopedKeyDatabase, searchCachedMessages } = await import("/src/crypto/keyStorage.ts");
        const { SERVER_URL } = await import("/src/utils/constants.ts");
        publishAuthOwnerChange("bench");
        const db = await openScopedKeyDatabase("bench", SERVER_URL);
        const tx = db.transaction("messageCache", "readwrite");
        const expected = [];
        for (let i = 0; i < size; i++) {
          const id = String(i).padStart(5, "0");
          const channelId = i % 5 === 0 ? "other" : "target";
          const content = i % 3 === 0 ? "Été" : "Winter";
          if (channelId === "target" && content === "Été") expected.push(id);
          void tx.store.put({ messageId: id, channelId, dmChannelId: null, content, timestamp: i });
        }
        await tx.done;
        const samples = [];
        for (let i = 0; i < 4; i++) {
          const start = performance.now();
          const rows = await searchCachedMessages("target", "ÉTÉ");
          const elapsed = performance.now() - start;
          if (rows.length !== expected.length || rows.some((r, j) => r.messageId !== expected[j] || r.content !== "Été")) {
            throw new Error("Incorrect match contents or order");
          }
          if (i > 0) samples.push(elapsed);
        }
        return { size, matches: expected.length, samplesMs: samples };
      }, size);
      assert.equal(report.samplesMs.length, 3);
      console.log(JSON.stringify(report));
    }
  } finally {
    await browser.close();
  }
} finally {
  await server.close();
}
