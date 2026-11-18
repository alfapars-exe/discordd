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
    await page.route("**/benchmark.html", route => route.fulfill({ contentType: "text/html", body: "<title>Streaming search benchmark</title>" }));
    await page.goto(new URL("benchmark.html", server.resolvedUrls.local[0]).href);
    console.log("Chromium", browser.version());
    for (const kind of ["channel", "dm"]) for (const size of [1000, 10000, 50000]) {
      const report = await page.evaluate(async ({ size, kind }) => {
        const { openDB } = await import("/node_modules/idb/build/index.js");
        const { publishAuthOwnerChange } = await import("/src/api/authSessionEvents.ts");
        const { openScopedKeyDatabase } = await import("/src/crypto/keyStorage.ts");
        const { scanCachedSearchReferences, SEARCH_REFERENCE_BATCH_SIZE } = await import("/src/crypto/cachedSearchScan.ts");
        const { SERVER_URL } = await import("/src/utils/constants.ts");
        publishAuthOwnerChange("stream-benchmark");
        const source = await openScopedKeyDatabase("stream-benchmark", SERVER_URL);
        const seed = source.transaction("messageCache", "readwrite");
        await seed.store.clear();
        let expected = 0;
        for (let i = 0; i < size; i++) {
          const target = i % 5 !== 0, match = i % 3 === 0;
          if (target && match) expected++;
          await seed.store.put({ messageId: String(i).padStart(5, "0"), channelId: kind === "channel" ? (target ? "target" : "other") : "",
            dmChannelId: kind === "dm" ? (target ? "target" : "other") : null,
            content: match ? "Été" : "other", timestamp: i, sourceSequence: String(9007199254740992n + BigInt(i)) });
        }
        await seed.done;
        const sidecar = await openDB("search-stream-benchmark", 1, { upgrade(db) { db.createObjectStore("refs"); } });
        const samples = [];
        let peakBatch = 0;
        try {
          for (let repeat = 0; repeat < 10; repeat++) {
            await sidecar.clear("refs");
            const start = performance.now();
            const found = await scanCachedSearchReferences(kind, "target", "ÉTÉ", async batch => {
              peakBatch = Math.max(peakBatch, batch.length);
              if (batch.length > SEARCH_REFERENCE_BATCH_SIZE) throw new Error("Batch exceeds bound");
              const tx = sidecar.transaction("refs", "readwrite");
              const writes = batch.map(ref => {
                if ("content" in ref || ref.sourceSequence !== String(9007199254740992n + BigInt(ref.messageId))) throw new Error("Incorrect metadata projection");
                return tx.store.put(ref, ref.messageId);
              });
              await Promise.all(writes);
              await tx.done;
            });
            if (found !== expected || await sidecar.count("refs") !== expected) throw new Error("Missing or duplicate matches");
            if (repeat) samples.push(performance.now() - start);
          }
        } finally { sidecar.close(); }
        samples.sort((a,b) => a-b);
        return { kind, size, matches: expected, peakBatch, medianMs: samples[4], repetitions: 9,
          scope: "Real IndexedDB scan and sidecar metadata writes; one warmup. Not sorted page hydration, panel heap, transient peak or completed RF17 acceptance." };
      }, { size, kind });
      assert.ok(report.peakBatch <= 128);
      assert.equal(report.repetitions, 9);
      console.log(JSON.stringify(report));
    }
  } finally { await browser.close(); }
} finally { await server.close(); }
