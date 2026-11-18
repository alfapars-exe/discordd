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
    await page.route("**/contention.html", route => route.fulfill({ contentType: "text/html", body: "<title>Search write contention</title>" }));
    await page.goto(new URL("contention.html", server.resolvedUrls.local[0]).href);
    console.log(JSON.stringify({ node: process.version, chromium: browser.version() }));
    for (const kind of ["channel", "dm"]) for (const cancel of [false, true]) {
      const report = await page.evaluate(async ({ kind, cancel }) => {
        const { publishAuthOwnerChange } = await import("/src/api/authSessionEvents.ts");
        const { openScopedKeyDatabase } = await import("/src/crypto/keyStorage.ts");
        const { scanCachedSearchReferences } = await import("/src/crypto/cachedSearchScan.ts");
        const { SERVER_URL } = await import("/src/utils/constants.ts");
        publishAuthOwnerChange("contention-benchmark");
        const source = await openScopedKeyDatabase("contention-benchmark", SERVER_URL);
        const size = 10000, samples = [];
        const row = i => ({ messageId: String(i).padStart(5, "0"), channelId: kind === "channel" ? "target" : "",
          dmChannelId: kind === "dm" ? "target" : null, content: "Été", timestamp: i });
        for (let repeat = 0; repeat < 10; repeat++) {
          const seed = source.transaction("messageCache", "readwrite");
          await seed.store.clear();
          for (let i = 0; i < size; i++) void seed.store.put(row(i));
          await seed.done;
          const controller = new AbortController();
          let entered, release;
          const started = new Promise(resolve => { entered = resolve; });
          const stalled = new Promise(resolve => { release = resolve; });
          let batches = 0;
          const start = performance.now();
          const scan = scanCachedSearchReferences(kind, "target", "ÉTÉ", async () => {
            if (++batches === 1) { entered(); await stalled; }
          }, controller.signal);
          // Observe cancellation immediately, before the writer is queued.
          const outcome = scan.then(count => ({ count }), error => ({ error: error.name }));
          await started;
          const queued = performance.now();
          let committed = false;
          const write = source.put("messageCache", { ...row(size - 1), content: "changed" }).then(() => { committed = true; });
          await new Promise(resolve => setTimeout(resolve, 75));
          if (committed) throw new Error("Writer escaped coherent scan lock");
          const unlocked = performance.now();
          if (cancel) controller.abort(); else release();
          const result = await outcome;
          await write;
          const completed = performance.now();
          release();
          if (cancel ? result.error !== "AbortError" : result.count !== size) throw new Error("Unexpected scan outcome");
          if (cancel && batches !== 1) throw new Error("Cancelled scan delivered another batch");
          const next = await scanCachedSearchReferences(kind, "target", "ÉTÉ", async () => {});
          if (next !== size - 1) throw new Error("Committed edit missing from next scan");
          if (repeat) samples.push({ scanAndWriteMs: completed - start, writerWaitMs: completed - queued, releaseToWriteMs: completed - unlocked });
        }
        const median = key => samples.map(row => row[key]).sort((a, b) => a - b)[4];
        return { kind, cancel, size, repetitions: 9, injectedConsumerDelayMs: 75,
          writerWaitMedianMs: median("writerWaitMs"), releaseToWriteMedianMs: median("releaseToWriteMs"), samples,
          scope: "Native Chromium IndexedDB coherent scan, stalled metadata consumer and one source-cache edit. No WebSocket/network/decryption or full React panel load; not a live-receive capacity pass." };
      }, { kind, cancel });
      assert.equal(report.repetitions, 9);
      console.log(JSON.stringify(report));
    }
  } finally { await browser.close(); }
} finally { await server.close(); }
