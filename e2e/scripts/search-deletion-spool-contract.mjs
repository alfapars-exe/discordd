/** Runs against native IndexedDB in a disposable browser context. */
export async function verifySearchDeletionSpool() {
  const phase = name => console.debug("native-spool-phase", name);
  phase("module-load");
  const auth = await import("/src/api/authSessionEvents.ts");
  const { openCachedSearchDeletionPool } = await import("/src/crypto/cachedSearchDeletionSpool.ts");
  const { openSearchDatabase, withResetCachedSearchSnapshots } = await import("/src/crypto/cachedSearchDatabase.ts");
  const { getAccountDatabaseName } = await import("/src/crypto/keyDatabase.ts");
  const { SERVER_URL } = await import("/src/utils/constants.ts");
  const owner = `native-spool-${crypto.randomUUID()}`;
  auth.publishAuthOwnerChange(owner);
  const sourceName = await getAccountDatabaseName(owner, SERVER_URL), name = `${sourceName}.search.v1`;
  const pools = [];
  const check = (value, message) => { if (!value) throw new Error(message); };
  const rejected = async task => { try { await task; } catch (error) { return error; } throw new Error("Expected native spool rejection"); };
  const pool = async () => { const value = await openCachedSearchDeletionPool(); pools.push(value); return value; };
  let notifications = 0;
  try {
    phase("bounded-drain");
    const writer = await pool(), frontier = writer.create(() => { notifications++; });
    phase("pool-opened");
    for (let i = 0; i < 1000; i++) { frontier.append(`id-${i}`); frontier.append(`id-${i}`); }
    phase("initial-writes-queued");
    const seen = new Set(); let maxBatch = 0;
    await frontier.drain(async ids => {
      maxBatch = Math.max(maxBatch, ids.length);
      for (const id of ids) { check(!seen.has(id), "Duplicate native spool delivery"); seen.add(id); }
      phase(`consumed-${seen.size}`);
      if (!seen.has("0-late")) frontier.append("0-late");
    });
    check(seen.size === 1001 && maxBatch <= 128, "Native spool count/batch mismatch");
    phase("empty-read-race");
    const getKeys = IDBObjectStore.prototype.getAllKeys;
    let emptyReads = 0, injectedLate = false;
    IDBObjectStore.prototype.getAllKeys = function (...args) {
      if (this.name === "refs") emptyReads++;
      return getKeys.apply(this, args);
    };
    try { await frontier.drain(async () => { throw new Error("Settled frontier repeated a row"); }); }
    finally { IDBObjectStore.prototype.getAllKeys = getKeys; }
    check(emptyReads === 0, "Settled pagination reopened native frontier read");
    const fastController = new AbortController();
    const fastDrain = frontier.drain(async () => {}, fastController.signal);
    queueMicrotask(() => fastController.abort());
    check((await rejected(fastDrain)).name === "AbortError", "Settled native drain ignored late abort");
    frontier.append("race-initial");
    IDBObjectStore.prototype.getAllKeys = function (...args) {
      const request = getKeys.apply(this, args);
      if (this.name === "refs") request.addEventListener("success", () => {
        if (!injectedLate && request.result.length === 0) { injectedLate = true; frontier.append("race-late"); }
      });
      return request;
    };
    const raced = [];
    try { await frontier.drain(async ids => raced.push(...ids)); }
    finally { IDBObjectStore.prototype.getAllKeys = getKeys; }
    check(injectedLate && JSON.stringify(raced) === '["race-initial","race-late"]', "Native empty read lost a concurrent deletion");
    phase("consumer-retry");
    frontier.append("retry");
    check((await rejected(frontier.drain(async () => { throw new Error("consumer failed"); }))).message === "consumer failed", "Consumer failure lost");
    const controller = new AbortController();
    check((await rejected(frontier.drain(async () => { controller.abort(); }, controller.signal))).name === "AbortError", "Native drain ignored cancellation");
    const retry = [];
    await frontier.drain(async ids => retry.push(...ids));
    check(JSON.stringify(retry) === '["retry"]', "Unacknowledged IDs lost on error/abort");
    await frontier.dispose();

    // Inject failure at the native storage boundary, not a mocked pool API.
    // This validates error handling; it does not claim physical disk exhaustion.
    for (const mode of ["quota", "transaction-abort"]) {
      phase(mode);
      let failures = 0;
      const broken = writer.create(() => { failures++; });
      const original = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (...args) {
        if (this.name !== "refs") return original.apply(this, args);
        if (mode === "quota") throw new DOMException("Synthetic native spool quota", "QuotaExceededError");
        const request = original.apply(this, args); this.transaction.abort(); return request;
      };
      try {
        if (mode === "quota") {
          let error; try { broken.append("failed"); } catch (caught) { error = caught; }
          check(error?.name === "QuotaExceededError", "Native quota failure hidden");
        } else broken.append("failed");
      } finally { IDBObjectStore.prototype.put = original; }
      const failure = await rejected(broken.drain(async () => { throw new Error("Failed write reached consumer"); }));
      check(mode === "quota" ? failure.name === "QuotaExceededError" : failure.name === "AbortError", `Wrong native writer failure: ${mode}/${failure.name}/${failure.message}`);
      check(failures === 1, "Native writer did not notify exactly once");
      await broken.dispose();
    }

    // Hold an actual native write lock across event-loop turns so writers
    // accumulate as inactive queued transactions, rather than a single burst.
    phase("writer-backpressure");
    const blockerDB = await openSearchDatabase(name);
    const blocker = blockerDB.transaction("refs", "readwrite");
    let holdLock = true;
    const pump = () => { void blocker.store.get(["fixture-lock"]).then(() => { if (holdLock) pump(); }); };
    pump();
    let backpressureNotifications = 0, accepted = 0, backpressure;
    const saturated = writer.create(() => { backpressureNotifications++; });
    try {
      for (let i = 0; i < 32; i++) {
        try { saturated.append(`queued-${i}`); accepted++; }
        catch (error) { backpressure = error; break; }
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    } finally { holdLock = false; await blocker.done; blockerDB.close(); }
    check(backpressure?.message === "search_spool_storage_backpressure" && accepted === 16, "Native queued writer bound failed");
    check((await rejected(saturated.drain(async () => { throw new Error("Saturated spool reached consumer"); }))).message === "search_spool_storage_backpressure", "Saturated query reported success");
    check(backpressureNotifications === 1, "Backpressure did not notify exactly once");
    await saturated.dispose();

    phase("reset-fence");
    const resetFrontier = writer.create(() => { notifications++; }); resetFrontier.append("reset");
    let releaseConsumer, enteredConsumer;
    const heldConsumer = new Promise(resolve => { releaseConsumer = resolve; });
    const consumerEntered = new Promise(resolve => { enteredConsumer = resolve; });
    const staleDrain = rejected(resetFrontier.drain(async () => { enteredConsumer(); await heldConsumer; }));
    await consumerEntered;
    let resetFenced = false;
    await withResetCachedSearchSnapshots(sourceName, async () => {
      resetFenced = (await rejected(openCachedSearchDeletionPool())).message === "search_spool_scope_unavailable";
      check(writer.closed, "Reset did not retire native pool");
    });
    check(resetFenced, "Reset admitted a replacement pool");
    await rejected(resetFrontier.drain(async () => {}));
    const db = await openSearchDatabase(name);
    try { check(await db.count("refs") === 0 && await db.count("snapshots") === 0, "Reset left native spool metadata"); }
    finally { db.close(); }

    phase("successor-preservation");
    const replacement = await pool(), retired = replacement.create(() => { notifications++; }); retired.append("reset");
    releaseConsumer();
    check((await staleDrain).message === "search_spool_disposed", "Reset consumer continued after retirement");
    const successor = [];
    await retired.drain(async ids => successor.push(...ids));
    check(JSON.stringify(successor) === '["reset"]', "Stale consumer touched replacement frontier");
    retired.append("retired");
    phase("scope-retirement");
    auth.publishAuthGenerationChange(auth.getAuthSessionSnapshot().generation + 1);
    check(replacement.closed, "Session replacement kept native pool open");
    await rejected(retired.drain(async () => {}));
    const ownerPool = await pool(), ownerFrontier = ownerPool.create(() => { notifications++; });
    ownerFrontier.append("owner-retired");
    auth.publishAuthOwnerChange(`${owner}-replacement`);
    check(ownerPool.closed, "Owner replacement kept native pool open");
    await rejected(ownerFrontier.drain(async () => {}));
    check(notifications === 0, "Retirement notified a stale query");
    return { mode: "native-deletion-spool", uniqueIds: seen.size, maxBatch, cancelledWithoutLoss: true,
      settledEmptyReads: emptyReads, settledAbortRejected: true, emptyReadRaceReconciled: true,
      consumerRetry: true, quotaNotified: true, transactionAbortNotified: true, resetFenced: true,
      boundedQueuedWriters: accepted, backpressureNotified: true,
      resetMetadataCleared: true, staleConsumerRejected: true, successorPreserved: true,
      retiredGenerationRejected: true, retiredOwnerRejected: true };
  } finally {
    await Promise.all(pools.map(value => value.close()));
    await new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = resolve; request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("Native spool fixture cleanup blocked"));
    });
  }
}
