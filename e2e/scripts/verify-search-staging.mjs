import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "../../client/node_modules/vite/dist/node/index.js";
import { verifySearchDeletionDrain } from "./search-deletion-drain-contract.mjs";

const root = fileURLToPath(new URL("../../client/", import.meta.url));
const server = await createServer({ root, configFile: false, logLevel: "error", server: { host: "127.0.0.1", port: 0 } });
await server.listen();
try {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await context.route("**/staging.html", route => route.fulfill({ contentType: "text/html", body: "<title>Search staging contracts</title>" }));
    await page.goto(new URL("staging.html", server.resolvedUrls.local[0]).href);
    console.log("Runtime", process.version, process.platform, "Chromium", browser.version());
    let drainDeadline;
    try {
      const drain = await Promise.race([
        page.evaluate(verifySearchDeletionDrain),
        new Promise((_, reject) => { drainDeadline = setTimeout(() => reject(new Error("Native deletion drain deadline exceeded")), 30_000); }),
      ]);
      assert.equal(drain.results.length, 2);
      assert.equal(drain.cancelled, true);
      assert.equal(drain.retiredOwnerRejected, true);
      assert.equal(drain.failedEvictionHiddenAfterReopen, true);
      assert.equal(drain.retryCommitted, true);
      assert.equal(drain.journalWriteDuringCoherentRead, true);
      assert.equal(drain.queuedEvictionReleased, true);
      console.log(JSON.stringify(drain));
    } finally { clearTimeout(drainDeadline); }
    for (const mode of ["channel", "dm", "mixed", "quota", "cancel"]) {
      let deadline;
      try {
        const result = await Promise.race([
          page.evaluate(async mode => {
            const { publishAuthOwnerChange } = await import("/src/api/authSessionEvents.ts");
            const { openScopedKeyDatabase, getAccountDatabaseName } = await import("/src/crypto/keyStorage.ts");
            const { createCachedSearchSnapshot } = await import("/src/crypto/cachedSearchSnapshot.ts");
            const { sortDMBySource } = await import("/src/utils/dmSourceOrder.ts");
            const { SERVER_URL } = await import("/src/utils/constants.ts");
            const { openDB } = await import("/node_modules/idb/build/index.js");
            const owner = "native-staging-contract";
            publishAuthOwnerChange(owner);
            const kind = mode === "channel" ? "channel" : "dm";
            const rows = Array.from({ length: 1201 }, (_, i) => ({
              messageId: String(i).padStart(4, "0"), timestamp: i,
              channelId: "channel", dmChannelId: "dm", content: "Été",
              sourceSequence: ((mode === "mixed" && i % 5 === 0) || mode === "quota" || mode === "cancel") ? undefined : String(9007199254740992n + BigInt(1201 - i)),
            }));
            const db = await openScopedKeyDatabase(owner, SERVER_URL);
            const seed = db.transaction("messageCache", "readwrite");
            await seed.store.clear();
            for (const row of rows) void seed.store.put(row);
            await seed.done;
            const expected = kind === "channel" ? [...rows].reverse().map(row => row.messageId)
              : sortDMBySource(rows.map(row => ({ id: row.messageId, created_at: new Date(row.timestamp).toISOString(), source_sequence: row.sourceSequence }))).reverse().map(row => row.id);
            const assertEmpty = async () => {
              const index = await openDB(`${await getAccountDatabaseName(owner, SERVER_URL)}.search.v1`, 1);
              try {
                if (await index.count("refs") || await index.count("snapshots")) throw new Error("Staging failure retained index rows");
              } finally { index.close(); }
            };
            let writes = 0, failureName;
            let writerReleased;
            const exerciseFailure = async () => {
              if (!["quota", "cancel"].includes(mode)) return;
              const original = IDBObjectStore.prototype.put;
              const controller = new AbortController();
              IDBObjectStore.prototype.put = function (...args) {
                const failurePoint = this.name === "refs" && ++writes === 300;
                if (failurePoint && mode === "quota") throw new DOMException("Synthetic quota failure", "QuotaExceededError");
                const result = original.apply(this, args);
                if (failurePoint) controller.abort();
                return result;
              };
              let unexpected;
              try {
                unexpected = await createCachedSearchSnapshot(kind, kind, "ÉTÉ", controller.signal);
              } catch (error) {
                failureName = error.name;
                const expectedQuota = mode !== "quota" || failureName === "QuotaExceededError";
                const expectedCancel = mode !== "cancel" || controller.signal.aborted;
                if (!expectedQuota || !expectedCancel) throw error;
              } finally { IDBObjectStore.prototype.put = original; }
              if (unexpected) { await unexpected.dispose(); throw new Error("Injected staging failure was ignored"); }
              if (!failureName) throw new Error("Staging rejection was not observed");
              await assertEmpty();
              // A failed sidecar consumer must release its coherent source
              // reader so subsequent cache writes can acquire the store.
              const probe = db.transaction("messageCache", "readwrite");
              await Promise.all([
                probe.store.put({ ...rows[0], messageId: "staging-writer-probe", content: "other" }),
                probe.store.delete("staging-writer-probe"),
              ]);
              await probe.done;
              writerReleased = true;
            };
            await exerciseFailure();
            const snapshot = await createCachedSearchSnapshot(kind, kind, "ÉTÉ");
            let exactPages = 0;
            try {
              const checkPage = async (offset, limit) => {
                const actual = await snapshot.page(offset, limit);
                if (actual.total !== rows.length || actual.offset !== offset || JSON.stringify(actual.ids) !== JSON.stringify(expected.slice(offset, offset + limit))) {
                  throw new Error(`Incorrect ${mode} staging page at ${offset}`);
                }
                exactPages++;
              };
              for (let offset = 0; offset < rows.length; offset += 128) await checkPage(offset, 128);
              for (const offset of [0, 1000, 1024, 1200]) await checkPage(offset, 25);
              const controller = new AbortController();
              const originalDelete = IDBObjectStore.prototype.delete;
              IDBObjectStore.prototype.delete = function (...args) {
                const request = originalDelete.apply(this, args);
                if (this.name === "refs") controller.abort();
                return request;
              };
              let canceled = false;
              try { await snapshot.removeMany(expected.slice(0, 2), controller.signal); }
              catch (error) { if (error.name !== "AbortError") throw error; canceled = true; }
              finally { IDBObjectStore.prototype.delete = originalDelete; }
              if (!canceled) throw new Error("Removal cancellation was ignored");
              await checkPage(0, 25);
              const deleted = await snapshot.removeMany([expected[0], "absent-id", expected[1], expected[0]]);
              const remaining = await snapshot.page(0, 25);
              if (deleted.removed !== 2 || deleted.total !== rows.length - 2 || remaining.total !== rows.length - 2 ||
                  JSON.stringify(remaining.ids) !== JSON.stringify(expected.slice(2, 27))) {
                throw new Error("Incorrect atomic batch removal or total");
              }
            } finally { await snapshot.dispose(); }
            await assertEmpty();
            return { mode, records: rows.length, exactPages, failureName, failureWrites: writes, writerReleased, atomicRemovalAndCancellation: true, indexDisposed: true };
          }, mode),
          new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error(`Native staging deadline exceeded: ${mode}`)), 30_000); }),
        ]);
        console.log(JSON.stringify(result));
      } finally { clearTimeout(deadline); }
    }
    assert.deepEqual(errors, []);
    await context.close();
  } finally { await browser.close(); }
} finally { await server.close(); }
