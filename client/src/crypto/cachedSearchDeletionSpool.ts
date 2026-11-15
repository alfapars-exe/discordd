import { unwrap, type IDBPTransaction } from "idb";
import { getAuthSessionSnapshot, subscribeAuthGenerationChanges, subscribeAuthOwnerChanges } from "../api/authSessionEvents";
import { SERVER_URL } from "../utils/constants";
import { getAccountDatabaseName } from "./keyDatabase";
import { openSearchDatabase, isCachedSearchResetting, registerCachedSearchResource } from "./cachedSearchDatabase";
import { SEARCH_SNAPSHOT_MAX_AGE_MS } from "./cachedSearchSnapshot";

const range = (id: string) => IDBKeyRange.bound([id], [id + "\x00"], false, true);
const MAX_WRITERS = 16;
export type SearchDeletionSpool = {
  readonly version: number;
  append: (messageId: string) => void;
  drain: (remove: (ids: readonly string[]) => Promise<unknown>, signal?: AbortSignal) => Promise<void>;
  dispose: () => Promise<void>;
};
export type SearchDeletionPool = {
  readonly closed: boolean;
  create: (onFailure: () => void) => SearchDeletionSpool;
  close: () => Promise<void>;
};

/** Prepare the native writer before admitting a query. No Promise, listener or
 * JavaScript ID collection is allocated for each incoming deletion: put clones
 * its metadata into IndexedDB. Native queue/physical peak require separate
 * platform budgets; queued transactions are capped independently of ID count.
 */
export async function openCachedSearchDeletionPool(): Promise<SearchDeletionPool> {
  const scope = getAuthSessionSnapshot();
  const scopeCurrent = () => { const now = getAuthSessionSnapshot(); return now.ownerId === scope.ownerId && now.generation === scope.generation; };
  const name = `${await getAccountDatabaseName(scope.ownerId ?? "", SERVER_URL)}.search.v1`;
  if (!scopeCurrent()) throw new Error("e2ee_account_scope_changed");
  const db = await openSearchDatabase(name);
  if (!scopeCurrent() || isCachedSearchResetting(name)) { db.close(); throw new Error("search_spool_scope_unavailable"); }
  const frontiers = new Set<SearchDeletionSpool>();
  let closed = false, closing: Promise<void> | undefined;
  let stopOwner = () => {}, stopGeneration = () => {}, stopResource = () => {};
  const close = (): Promise<void> => {
    if (closing) return closing;
    closed = true; stopOwner(); stopGeneration(); stopResource();
    closing = Promise.allSettled([...frontiers].map(frontier => frontier.dispose())).then(results => {
      db.close();
      const failed = results.find(result => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    });
    return closing;
  };
  const retire = () => { if (!scopeCurrent()) void close().catch(() => {}); };
  stopOwner = subscribeAuthOwnerChanges(retire); stopGeneration = subscribeAuthGenerationChanges(retire);
  stopResource = registerCachedSearchResource(name, close);

  return {
    get closed() { return closed; }, close,
    create(onFailure) {
      if (closed || !scopeCurrent() || isCachedSearchResetting(name)) throw new Error("search_spool_scope_unavailable");
      const id = crypto.randomUUID(), expiresAt = Date.now() + SEARCH_SNAPSHOT_MAX_AGE_MS;
      let disposed = false, failed = false, problem: unknown, revision = 0, drainedRevision = 0;
      let lastId: string | null = null;
      let notify: (() => void) | undefined = onFailure;
      let writer: IDBTransaction | null = null, disposal: Promise<void> | undefined, draining: Promise<void> | null = null;
      const writes = new Set<IDBTransaction>(), reads = new Set<IDBPTransaction<unknown, string[], "readonly" | "readwrite">>();
      const waiters = new Set<() => void>();
      const wake = () => { for (const done of [...waiters]) done(); };
      const fail = (error: unknown) => {
        if (disposed || failed) return;
        failed = true; problem = error;
        queueMicrotask(() => { if (!disposed && scopeCurrent()) notify?.(); });
      };
      const check = (signal?: AbortSignal) => {
        signal?.throwIfAborted();
        if (failed) throw problem;
        if (disposed || closed || !scopeCurrent() || isCachedSearchResetting(name)) throw new Error("search_spool_disposed");
        if (Date.now() >= expiresAt) throw new Error("search_spool_expired");
      };
      const nextWriter = () => {
        check();
        if (writes.size >= MAX_WRITERS) throw new Error("search_spool_storage_backpressure");
        const tx = unwrap(db).transaction(["refs", "snapshots"], "readwrite");
        writes.add(tx); writer = tx;
        const ended = () => { writes.delete(tx); if (writer === tx) writer = null; wake(); };
        tx.oncomplete = ended;
        tx.onabort = () => { if (!disposed) fail(tx.error ?? new Error("search_spool_write_aborted")); ended(); };
        tx.onerror = event => fail((event.target as IDBRequest).error ?? tx.error ?? new Error("search_spool_write_failed"));
        return tx;
      };
      const flush = async (signal?: AbortSignal) => {
        check(signal);
        while (writes.size) {
          await new Promise<void>((resolve, reject) => {
            const stop = () => { waiters.delete(done); signal?.removeEventListener("abort", abort); };
            const done = () => { stop(); resolve(); };
            const abort = () => { stop(); reject(signal?.reason); };
            waiters.add(done); signal?.addEventListener("abort", abort, { once: true });
            if (signal?.aborted) abort();
          });
          check(signal);
        }
      };
      const transaction = async <T, M extends "readonly" | "readwrite">(mode: M, run: (tx: IDBPTransaction<unknown, string[], M>) => Promise<T>, signal?: AbortSignal): Promise<T> => {
        check(signal);
        const tx = db.transaction(["refs"], mode); reads.add(tx); void tx.done.catch(() => {});
        const abort = () => { try { tx.abort(); } catch { /* Complete. */ } };
        signal?.addEventListener("abort", abort, { once: true });
        try { const result = await run(tx); check(signal); await tx.done; check(signal); return result; }
        catch (error) { abort(); await tx.done.catch(() => {}); throw error; }
        finally { reads.delete(tx); signal?.removeEventListener("abort", abort); }
      };
      const frontier: SearchDeletionSpool = {
        get version() { check(); return revision; },
        append(messageId) {
          check();
          if (lastId === messageId) return;
          lastId = messageId; revision++;
          try {
            let tx = writer;
            if (tx) {
              try { tx.objectStore("refs").put({ snapshotId: id, messageId }); return; }
              catch (error) { if (!(error instanceof DOMException) || error.name !== "TransactionInactiveError") throw error; }
            }
            tx = nextWriter(); tx.objectStore("refs").put({ snapshotId: id, messageId });
          } catch (error) { fail(error); throw error; }
        },
        async drain(remove, signal) {
          check(signal);
          const previous = draining;
          const run = async () => {
            for (;;) {
              await flush(signal);
              check(signal);
              if (drainedRevision === revision) return;
              const readRevision = revision;
              const ids = await transaction("readonly", async tx => {
                const keys = await tx.objectStore("refs").getAllKeys(range(id), 128);
                return keys.map(key => (key as [string, string])[1]);
              }, signal);
              if (!ids.length) {
                // A native read can finish before a newly queued write.
                // Only acknowledge the revision that this empty read observed.
                if (readRevision !== revision) continue;
                drainedRevision = readRevision;
                return;
              }
              await remove(ids); check(signal);
              await transaction("readwrite", async tx => { await Promise.all(ids.map(async messageId => tx.objectStore("refs").delete([id, messageId]))); }, signal);
            }
          };
          // Reserve the tail before yielding. Multiple waiters must not all
          // resume the same predecessor and consume its unacknowledged rows.
          const task = (previous ? previous.catch(() => {}) : Promise.resolve()).then(run); draining = task;
          try { await task; } finally { if (draining === task) draining = null; }
        },
        dispose() {
          if (disposal) return disposal;
          disposed = true; notify = undefined; lastId = null; frontiers.delete(frontier);
          for (const tx of writes) { try { tx.abort(); } catch { /* Complete. */ } }
          for (const tx of reads) { try { tx.abort(); } catch { /* Complete. */ } }
          wake();
          disposal = (async () => {
            const tx = db.transaction(["refs", "snapshots"], "readwrite"); void tx.done.catch(() => {});
            try { await Promise.all([tx.objectStore("refs").delete(range(id)), tx.objectStore("snapshots").delete(id)]); await tx.done; }
            catch (error) { try { tx.abort(); } catch { /* Complete. */ } await tx.done.catch(() => {}); throw error; }
          })();
          return disposal;
        },
      };
      try { nextWriter().objectStore("snapshots").put({ id, expiresAt, total: 0, ready: false, orderIndex: "time" }); }
      catch (error) { void frontier.dispose().catch(() => {}); throw error; }
      frontiers.add(frontier);
      return frontier;
    },
  };
}
