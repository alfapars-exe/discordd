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
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await context.route("**/staging.html", route => route.fulfill({ contentType: "text/html", body: "<title>Search staging contracts</title>" }));
    await page.goto(new URL("staging.html", server.resolvedUrls.local[0]).href);
    console.log("Runtime", process.version, process.platform, "Chromium", browser.version());
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
            if (mode === "quota" || mode === "cancel") {
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
                if (mode === "quota" && failureName !== "QuotaExceededError") throw error;
                if (mode === "cancel" && !controller.signal.aborted) throw error;
              } finally { IDBObjectStore.prototype.put = original; }
              if (unexpected) { await unexpected.dispose(); throw new Error("Injected staging failure was ignored"); }
              if (!failureName) throw new Error("Staging rejection was not observed");
              await assertEmpty();
            }
            const snapshot = await createCachedSearchSnapshot(kind, kind, "ÉTÉ");
            try {
              for (const offset of [0, 1000, 1024, 1200]) {
                const actual = await snapshot.page(offset, 25);
                if (actual.total !== rows.length || actual.offset !== offset || JSON.stringify(actual.ids) !== JSON.stringify(expected.slice(offset, offset + 25))) {
                  throw new Error(`Incorrect ${mode} staging page at ${offset}`);
                }
              }
            } finally { await snapshot.dispose(); }
            await assertEmpty();
            return { mode, records: rows.length, exactPages: 4, failureName, failureWrites: writes, indexDisposed: true };
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
