import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "../../client/node_modules/vite/dist/node/index.js";

const dm = process.argv.includes("--dm");
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
      const report = await page.evaluate(async ({ size, dm }) => {
        const { publishAuthOwnerChange } = await import("/src/api/authSessionEvents.ts");
        const { getCachedDecryptedMessage, openScopedKeyDatabase, searchCachedMessages, searchCachedDMMessages, searchCachedDMMessageRefs, searchCachedMessageRefs } = await import("/src/crypto/keyStorage.ts");
        const { sortDMBySource } = await import("/src/utils/dmSourceOrder.ts");
        const search = dm ? searchCachedDMMessages : searchCachedMessages;
        const { SERVER_URL } = await import("/src/utils/constants.ts");
        publishAuthOwnerChange(dm ? "bench-dm" : "bench");
        const db = await openScopedKeyDatabase(dm ? "bench-dm" : "bench", SERVER_URL);
        const tx = db.transaction("messageCache", "readwrite");
        await tx.store.clear();
        const expected = [];
        for (let i = 0; i < size; i++) {
          const id = String(i).padStart(5, "0");
          const channelId = i % 5 === 0 ? "other" : "target";
          const content = i % 3 === 0 ? "Été" : "Winter";
          if (channelId === "target" && content === "Été") expected.push(id);
          void tx.store.put({ messageId: id, channelId: dm ? null : channelId, dmChannelId: dm ? channelId : null, content, timestamp: dm ? size - i : i, sourceSequence: dm ? String(i + 1) : undefined });
        }
        await tx.done;
        const samples = [];
        const previousPageMs = [];
        const indexedPageMs = [];
        const compactFirstPageMs = [];
        const expectedPage = expected.toReversed().slice(25, 50);
        for (let i = 0; i < 4; i++) {
          const start = performance.now();
          const rows = await search("target", "ÉTÉ");
          const elapsed = performance.now() - start;
          if (rows.length !== expected.length || rows.some((r, j) => r.messageId !== expected[j] || r.content !== "Été")) {
            throw new Error("Incorrect match contents or order");
          }
          if (i > 0) samples.push(elapsed);
          const sortStart = performance.now();
          const sorted = dm
            ? sortDMBySource(rows.map(record => ({ id: record.messageId, created_at: new Date(record.timestamp).toISOString(), source_sequence: record.sourceSequence, record }))).reverse().map(item => item.record)
            : rows.sort((a, b) => b.timestamp - a.timestamp);
          const oldPage = sorted.slice(25, 50);
          const oldElapsed = elapsed + performance.now() - sortStart;
          const ids = sorted.map(row => row.messageId);
          const pageStart = performance.now();
          const page = (await Promise.all(ids.slice(25, 50).map(getCachedDecryptedMessage)))
            .filter(row => (dm ? row?.dmChannelId : row?.channelId) === "target" && row.content.toLowerCase().includes("été"));
          const pageElapsed = performance.now() - pageStart;
          for (const result of [oldPage, page]) {
            if (result.length !== 25 || result.some((r, j) => r.messageId !== expectedPage[j] || r.content !== "Été")) {
              throw new Error("Incorrect second page");
            }
          }
          {
            const compactStart = performance.now();
            const refs = await (dm ? searchCachedDMMessageRefs : searchCachedMessageRefs)("target", "ÉTÉ");
            if (refs.some(ref => "content" in ref)) throw new Error("Reference scan retained plaintext");
            const orderedIds = dm ? sortDMBySource(refs.map(ref => ({
              id: ref.messageId, created_at: new Date(ref.timestamp).toISOString(), source_sequence: "sourceSequence" in ref ? ref.sourceSequence : undefined,
            }))).reverse().map(ref => ref.id) : refs.sort((a, b) => b.timestamp - a.timestamp).map(ref => ref.messageId);
            if (orderedIds.length !== expected.length || orderedIds.some((id, j) => id !== expected[expected.length - 1 - j])) {
              throw new Error("Incorrect compact reference order");
            }
            const firstPage = await Promise.all(orderedIds.slice(0, 25).map(id => getCachedDecryptedMessage(id)));
            if (firstPage.some((row, j) => row?.messageId !== orderedIds[j] || row.content !== "Été")) {
              throw new Error("Incorrect compact first page");
            }
            if (i > 0) compactFirstPageMs.push(performance.now() - compactStart);
          }
          if (i > 0) {
            previousPageMs.push(oldElapsed);
            indexedPageMs.push(pageElapsed);
          }
        }
        return { mode: dm ? "dm" : "channel", size, matches: expected.length, samplesMs: samples, previousPageMs, indexedPageMs, compactFirstPageMs };
      }, { size, dm });
      assert.equal(report.samplesMs.length, 3);
      console.log(JSON.stringify(report));
    }
  } finally {
    await browser.close();
  }
} finally {
  await server.close();
}
