import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { isCachedSearchResetting, openSearchDatabase, registerCachedSearchResource, withResetCachedSearchSnapshots } from "./cachedSearchDatabase";

const source = "reset-contract", name = `${source}.search.v1`;
const unregister: (() => void)[] = [];
beforeEach(() => { globalThis.indexedDB = new IDBFactory(); });
afterEach(() => { for (const stop of unregister.splice(0)) stop(); vi.restoreAllMocks(); });
async function seedIndex() {
 const db = await openSearchDatabase(name);
 await db.put("refs", { snapshotId: "snapshot", messageId: "message" });
 await db.put("snapshots", { id: "snapshot", expiresAt: 1 });
 db.close();
}
async function indexCounts() {
 const db = await openSearchDatabase(name);
 try { return [await db.count("refs"), await db.count("snapshots")]; }
 finally { db.close(); }
}
function failIndexClear(failure: unknown) {
 const original = IDBObjectStore.prototype.clear;
 return vi.spyOn(IDBObjectStore.prototype, "clear").mockImplementation(function (this: IDBObjectStore) {
  if (this.name === "refs") throw failure;
  return original.call(this);
 });
}
it("does not create a derived database for an account that never searched", async () => {
 expect(await withResetCachedSearchSnapshots(source, async () => "reset-value")).toBe("reset-value");
 expect(await indexedDB.databases()).toEqual([]);
 expect(isCachedSearchResetting(name)).toBe(false);
});
it("continues reset and clears both stores when an asynchronous disposer fails", async () => {
 await seedIndex();
 const reset = vi.fn(async () => {
  expect(isCachedSearchResetting(name)).toBe(true);
  return 42;
 });
 unregister.push(registerCachedSearchResource(name, async () => { throw new Error("disposer-failed"); }));
 expect(await withResetCachedSearchSnapshots(source, reset)).toBe(42);
 expect(reset).toHaveBeenCalledOnce();
 expect(await indexCounts()).toEqual([0, 0]);
 expect(isCachedSearchResetting(name)).toBe(false);
});
it.each([undefined, new Error("source-reset-failed")])("preserves the original source failure when index cleanup also fails (%s)", async failure => {
 await seedIndex();
 const cleanupFailure = new Error("index-clear-failed");
 failIndexClear(cleanupFailure);
 const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
 await expect(withResetCachedSearchSnapshots(source, async () => { throw failure; })).rejects.toBe(failure);
 expect(warn).toHaveBeenCalledExactlyOnceWith("[e2ee] search index cleanup failed after an unsuccessful key reset");
 expect(isCachedSearchResetting(name)).toBe(false);
 expect(await indexCounts()).toEqual([1, 1]);
});
it("reports a cleanup failure after a successful source reset and releases the fence", async () => {
 await seedIndex();
 const failure = new Error("index-clear-failed");
 failIndexClear(failure);
 await expect(withResetCachedSearchSnapshots(source, async () => 42)).rejects.toBe(failure);
 expect(isCachedSearchResetting(name)).toBe(false);
 expect(await indexCounts()).toEqual([1, 1]);
});
it("does not clear a successor account index after source reset retires the owner", async () => {
 await seedIndex();
 let current = true;
 expect(await withResetCachedSearchSnapshots(source, async () => { current = false; return 42; }, () => current)).toBe(42);
 expect(await indexCounts()).toEqual([1, 1]);
 expect(isCachedSearchResetting(name)).toBe(false);
});
it("rejects an owner retired by resource disposal before invoking source reset", async () => {
 await seedIndex();
 let current = true;
 unregister.push(registerCachedSearchResource(name, async () => { current = false; }));
 const reset = vi.fn(async () => 42);
 await expect(withResetCachedSearchSnapshots(source, reset, () => current)).rejects.toThrow("e2ee_account_scope_changed");
 expect(reset).not.toHaveBeenCalled();
 expect(await indexCounts()).toEqual([1, 1]);
 expect(isCachedSearchResetting(name)).toBe(false);
});

it("clears an existing index when database enumeration is unavailable", async () => {
 await seedIndex();
 // Older IndexedDB implementations do not expose databases(). This factory
 // belongs only to this test and is replaced by beforeEach.
 Object.defineProperty(indexedDB, "databases", { value: undefined, configurable: true });
 expect(await withResetCachedSearchSnapshots(source, async () => 42)).toBe(42);
 expect(await indexCounts()).toEqual([0, 0]);
 expect(isCachedSearchResetting(name)).toBe(false);
});
it("rejects an initially retired owner before disposing resources or resetting data", async () => {
 const dispose = vi.fn(async () => {}), reset = vi.fn(async () => 42);
 unregister.push(registerCachedSearchResource(name, dispose));
 await expect(withResetCachedSearchSnapshots(source, reset, () => false)).rejects.toThrow("e2ee_account_scope_changed");
 expect(dispose).not.toHaveBeenCalled();
 expect(reset).not.toHaveBeenCalled();
 expect(await indexedDB.databases()).toEqual([]);
 expect(isCachedSearchResetting(name)).toBe(false);
});
