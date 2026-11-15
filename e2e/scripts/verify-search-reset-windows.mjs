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
    const context = await browser.newContext();
    const receiver = await context.newPage(), sender = await context.newPage();
    const errors = [];
    for (const page of [receiver, sender]) {
      page.on("pageerror", error => errors.push(error.message));
      await page.route("**/reset.html", route => route.fulfill({ contentType: "text/html", body: "<title>Search reset probe</title>" }));
      await page.goto(new URL("reset.html", server.resolvedUrls.local[0]).href);
    }
    await receiver.evaluate(async () => {
      const auth = await import("/src/api/authSessionEvents.ts");
      auth.publishAuthOwnerChange("reset-window-owner");
      const epochs = await import("/src/crypto/cachedSearchEpoch.ts");
      const original = indexedDB.open.bind(indexedDB);
      globalThis.probe = { opens: 0, received: 0, epochs };
      indexedDB.open = (...args) => { globalThis.probe.opens++; return original(...args); };
      const observer = new BroadcastChannel("hichat.search-reset.v1");
      observer.onmessage = () => { globalThis.probe.received++; };
      globalThis.probe.observer = observer;
    });
    await sender.evaluate(() => {
      const channel = new BroadcastChannel("hichat.search-reset.v1");
      channel.postMessage({ sourceName: "foreign-account-database" }); channel.close();
    });
    await receiver.waitForFunction(() => globalThis.probe.received === 1);
    // Allow asynchronous namespace derivation to complete before checking the
    // negative observation; this bounded quiet window is recorded in evidence.
    await receiver.waitForTimeout(250);
    assert.equal(await receiver.evaluate(() => globalThis.probe.opens), 0);
    const expectedName = await receiver.evaluate(async () => {
      const keys = await import("/src/crypto/keyStorage.ts");
      const { SERVER_URL } = await import("/src/utils/constants.ts");
      const { createCachedSearchSnapshot } = await import("/src/crypto/cachedSearchSnapshot.ts");
      await keys.cacheDecryptedMessage({ messageId: "private-result", channelId: "target", timestamp: 1, content: "private phrase" });
      globalThis.probe.snapshot = await createCachedSearchSnapshot("channel", "target", "private");
      const first = await globalThis.probe.snapshot.page(0, 25);
      if (first.ids.join() !== "private-result") throw new Error("Initial search result missing");
      return keys.getAccountDatabaseName("reset-window-owner", SERVER_URL);
    });
    await sender.evaluate(async () => {
      const auth = await import("/src/api/authSessionEvents.ts");
      auth.publishAuthOwnerChange("reset-window-owner");
      const { clearAllE2EEData } = await import("/src/crypto/keyStorage.ts");
      await clearAllE2EEData();
    });
    await receiver.waitForFunction(() => globalThis.probe.epochs.getCachedSearchResetGeneration() > 0);
    const result = await receiver.evaluate(async expectedName => {
      let rejection;
      try { await globalThis.probe.snapshot.page(0, 25); } catch (error) { rejection = error.message; }
      await globalThis.probe.snapshot.dispose();
      const { openDB } = await import("/node_modules/idb/build/index.js");
      const db = await openDB(expectedName + ".search.v1", 1);
      try { return { rejection, refs: await db.count("refs"), snapshots: await db.count("snapshots") }; }
      finally { db.close(); globalThis.probe.observer.close(); }
    }, expectedName);
    assert.deepEqual(result, { rejection: "search_snapshot_cache_reset", refs: 0, snapshots: 0 });
    const signedOut = await receiver.evaluate(async () => {
      const auth = await import("/src/api/authSessionEvents.ts");
      auth.publishAuthOwnerChange(null);
      const observer = new BroadcastChannel("hichat.search-reset.v1");
      observer.onmessage = () => { globalThis.probe.received++; };
      globalThis.probe.observer = observer;
      return { opens: globalThis.probe.opens, received: globalThis.probe.received };
    });
    await sender.evaluate(expectedName => {
      const channel = new BroadcastChannel("hichat.search-reset.v1");
      channel.postMessage({ sourceName: expectedName }); channel.close();
    }, expectedName);
    await receiver.waitForFunction(count => globalThis.probe.received > count, signedOut.received);
    await receiver.waitForTimeout(250);
    assert.equal(await receiver.evaluate(() => globalThis.probe.opens), signedOut.opens);
    await receiver.evaluate(() => globalThis.probe.observer.close());
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ chromium: browser.version(), foreignNotificationDatabaseOpens: 0, foreignQuietWindowMs: 250,
      signedOutNotificationDatabaseOpens: 0, sameAccountReset: result, scope: "Two same-origin native Chromium pages, real BroadcastChannel/IndexedDB and source modules. No React panel or packaged-platform acceptance." }));
    await context.close();
  } finally { await browser.close(); }
} finally { await server.close(); }
