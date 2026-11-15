/** Runs inside a native browser Page, with the client served by Vite.
 * Keep this function self-contained for both CI and interactive browser QA.
 */
export async function verifySearchDeletionDrain() {
  const storage = await import("/src/crypto/keyStorage.ts");
  const { publishAuthOwnerChange } = await import("/src/api/authSessionEvents.ts");
  const { reserveCachedMessageDeletion, waitForCachedMessageDeletions } = await import("/src/crypto/cachedMessageDeletions.ts");
  const { createCachedSearchSnapshot } = await import("/src/crypto/cachedSearchSnapshot.ts");
  const { SERVER_URL } = await import("/src/utils/constants.ts");
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
    return { mode: "accepted-deletion-drain", results, cancelled: true, retiredOwnerRejected: true };
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
