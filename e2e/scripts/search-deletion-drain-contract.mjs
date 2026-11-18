/** Runs inside a native browser Page, with the client served by Vite.
 * Keep this function self-contained for both CI and interactive browser QA.
 */
export async function verifySearchDeletionDrain() {
  const storage = await import("/src/crypto/keyStorage.ts");
  const { publishAuthOwnerChange } = await import("/src/api/authSessionEvents.ts");
  const { reserveCachedMessageDeletion, waitForCachedMessageDeletions } = await import("/src/crypto/cachedMessageDeletions.ts");
  const { createCachedSearchSnapshot } = await import("/src/crypto/cachedSearchSnapshot.ts");
  const { SERVER_URL } = await import("/src/utils/constants.ts");
  const { getDB } = await import("/src/crypto/keyDatabase.ts");
  const { cachedSearchDeletionKey } = await import("/src/crypto/cachedSearchDeletionJournal.ts");
  const { scanCachedSearchReferences } = await import("/src/crypto/cachedSearchScan.ts");
  const owner = `native-deletion-drain-${crypto.randomUUID()}`;
  publishAuthOwnerChange(owner);
  const name = await storage.getAccountDatabaseName(owner, SERVER_URL);
  const results = [];
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const frames = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  try {
    for (const kind of ["channel", "dm"]) {
      const channel = `drain-${kind}`;
      await storage.cacheDecryptedMessages([1, 2, 3].map(i => ({
        messageId: `${kind}-${i}`, channelId: kind === "channel" ? channel : "",
        dmChannelId: kind === "dm" ? channel : null, content: "probe", timestamp: i, sourceSequence: String(1000 + i),
      })));
      const finish = reserveCachedMessageDeletion(kind, channel);
      let settled = false;
      const creating = createCachedSearchSnapshot(kind, channel, "probe").then(value => { settled = true; return value; });
      try {
        await frames(); check(!settled, "Snapshot read before accepted deletion settled");
        if (kind === "channel") await storage.deleteCachedChannelMessage(`${kind}-2`, channel, () => true);
        else await storage.deleteCachedDMMessage(`${kind}-2`, channel, () => true);
        finish();
        const snapshot = await creating, page = await snapshot.page(0, 25);
        check(JSON.stringify(page.ids) === JSON.stringify([`${kind}-3`, `${kind}-1`]) && page.total === 2, "Deleted reference or wrong ordering");
        results.push({ kind, heldBeforeCleanup: true, ids: page.ids, total: page.total });
      } finally {
        finish();
        await (await creating.catch(() => null))?.dispose();
      }
    }
    // A failed physical eviction must stay hidden across connection reopen,
    // including backup collection, until an actual retry commits its removal.
    const stale = { messageId: "failed-eviction", channelId: "", dmChannelId: "drain-dm", content: "probe deleted plaintext", timestamp: 4, sourceSequence: "1004" };
    await storage.cacheDecryptedMessage(stale);
    const originalDelete = IDBObjectStore.prototype.delete;
    IDBObjectStore.prototype.delete = function (...args) {
      if (this.name === "messageCache" && args[0] === stale.messageId) throw new DOMException("Synthetic eviction failure", "UnknownError");
      return originalDelete.apply(this, args);
    };
    let failedEviction = false;
    try { await storage.deleteCachedDMMessage(stale.messageId, "drain-dm", () => true); }
    catch (error) { if (error.name !== "UnknownError") throw error; failedEviction = true; }
    finally { IDBObjectStore.prototype.delete = originalDelete; }
    check(failedEviction, "Physical eviction failure was ignored");
    check((await (await getDB()).get("messageCache", stale.messageId))?.content === stale.content, "Fixture did not retain physical plaintext");
    await storage.closeDB();
    check(await storage.getCachedDecryptedMessage(stale.messageId) === null, "Pending deletion became readable after reopen");
    check(!(await storage.getAllCachedMessages()).some(row => row.messageId === stale.messageId), "Backup collection revived pending plaintext");
    const recovered = await createCachedSearchSnapshot("dm", "drain-dm", "probe");
    try {
      const page = await recovered.page(0, 25);
      check(JSON.stringify(page.ids) === JSON.stringify(["dm-3", "dm-1"]) && page.total === 2, "Pending deletion corrupted exact page or total");
    } finally { await recovered.dispose(); }
    check(await storage.deleteCachedDMMessage(stale.messageId, "drain-dm", () => true), "Eviction retry did not commit");
    check(await (await getDB()).get("metadata", cachedSearchDeletionKey("dm", "drain-dm", stale.messageId)) === undefined, "Committed retry retained its intent");
    const live = { ...stale, messageId: "live-deletion", timestamp: 5, sourceSequence: "1005" };
    await storage.cacheDecryptedMessage(live);
    const originalPut = IDBObjectStore.prototype.put;
    let recorded;
    const journalRecorded = new Promise(resolve => { recorded = resolve; });
    IDBObjectStore.prototype.put = function (...args) {
      const request = originalPut.apply(this, args);
      if (this.name === "metadata" && args[1] === cachedSearchDeletionKey("dm", "drain-dm", live.messageId)) {
        request.addEventListener("success", () => recorded(), { once: true });
      }
      return request;
    };
    let deleting;
    try {
      const coherentCount = await scanCachedSearchReferences("dm", "drain-dm", "probe", async () => {
        if (deleting) return;
        deleting = storage.deleteCachedDMMessage(live.messageId, "drain-dm", () => true);
        // The journal must commit without waiting for the source read to end.
        // The subsequent cache eviction can queue until this consumer returns.
        await journalRecorded; await frames();
      });
      check(coherentCount === 3, "Source read lost its coherent snapshot");
      check(await deleting, "Queued cache eviction was not released after source read");
    } finally { IDBObjectStore.prototype.put = originalPut; }
    check(await scanCachedSearchReferences("dm", "drain-dm", "probe", async () => {}) === 2, "New source read revived an evicted row");
    const finish = reserveCachedMessageDeletion("channel", "drain-channel"), controller = new AbortController();
    try {
      const cancelled = createCachedSearchSnapshot("channel", "drain-channel", "probe", controller.signal)
        .then(async snapshot => { await snapshot.dispose(); return "unexpected success"; }, error => error.name);
      await frames(); controller.abort();
      check(await cancelled === "AbortError", "Pending drain ignored query abort");
    } finally { finish(); }
    const oldFinish = reserveCachedMessageDeletion("dm", "drain-dm");
    try {
      const retired = waitForCachedMessageDeletions("dm", "drain-dm")
        .then(() => false, error => error.message === "e2ee_account_scope_changed");
      publishAuthOwnerChange(`${owner}-replacement`);
      check(await retired, "Retired wait continued");
    } finally { oldFinish(); }
    return { mode: "accepted-deletion-drain", results, cancelled: true, retiredOwnerRejected: true, failedEvictionHiddenAfterReopen: true, retryCommitted: true, journalWriteDuringCoherentRead: true, queuedEvictionReleased: true };
  } finally {
    await storage.closeDB();
    // Only databases belonging to this exact random fixture are removed.
    for (const testName of [name, `${name}.search.v1`]) {
      await new Promise((resolve, reject) => {
        const request = indexedDB.deleteDatabase(testName);
        request.onsuccess = () => resolve(); request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error("Deletion drain fixture cleanup blocked"));
      });
    }
  }
}
