import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getAuthSessionSnapshot, publishAuthGenerationChange, publishAuthOwnerChange } from "../api/authSessionEvents";
import { closeDB, getAccountDatabaseName } from "./keyStorage";
import { openCachedSearchDeletionPool, type SearchDeletionPool } from "./cachedSearchDeletionSpool";
import { openSearchDatabase } from "./cachedSearchDatabase";
import { SERVER_URL } from "../utils/constants";

const pools: SearchDeletionPool[] = [];
async function pool() { const value = await openCachedSearchDeletionPool(); pools.push(value); return value; }
beforeEach(async () => { await closeDB(); globalThis.indexedDB = new IDBFactory(); publishAuthOwnerChange("spool-owner"); publishAuthGenerationChange(getAuthSessionSnapshot().generation + 1); });
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(pools.splice(0).map(value => value.close())); await closeDB(); });

it("spools distinct deletions and drains only bounded, deduplicated batches", async () => {
  const writer = await pool(), notify = vi.fn(), frontier = writer.create(notify);
  for (let i = 0; i < 1000; i++) { frontier.append(String(i)); frontier.append(String(i)); }
  const sizes: number[] = [], seen = new Set<string>();
  await frontier.drain(async ids => { sizes.push(ids.length); for (const id of ids) { expect(seen.has(id)).toBe(false); seen.add(id); } });
  expect(seen.size).toBe(1000); expect(Math.max(...sizes)).toBeLessThanOrEqual(128);
  await frontier.drain(async () => { throw new Error("consumed row returned"); });
  expect(notify).not.toHaveBeenCalled();
});

it("does not reread an empty frontier on ordinary search pagination", async () => {
  const frontier = (await pool()).create(vi.fn());
  const reads = vi.spyOn(IDBObjectStore.prototype, "getAllKeys");
  const consume = vi.fn(async () => {});
  await frontier.drain(consume);
  await frontier.drain(consume);
  expect(reads).not.toHaveBeenCalled();
  frontier.append("one");
  await frontier.drain(consume);
  expect(consume).toHaveBeenCalledExactlyOnceWith(["one"]);
  reads.mockClear();
  await frontier.drain(consume);
  expect(reads).not.toHaveBeenCalled();
  frontier.append("two");
  await frontier.drain(consume);
  expect(consume).toHaveBeenLastCalledWith(["two"]);
});

it("does not acknowledge an ID appended while an empty read completes", async () => {
  const frontier = (await pool()).create(vi.fn());
  frontier.append("initial");
  const original = IDBObjectStore.prototype.getAllKeys;
  let injected = false;
  vi.spyOn(IDBObjectStore.prototype, "getAllKeys").mockImplementation(function (this: IDBObjectStore, ...args) {
    const request = original.apply(this, args);
    if (this.name === "refs") request.addEventListener("success", () => {
      if (!injected && request.result.length === 0) { injected = true; frontier.append("late"); }
    });
    return request;
  });
  const seen: string[] = [];
  await frontier.drain(async ids => { seen.push(...ids); });
  expect(injected).toBe(true);
  expect(seen).toEqual(["initial", "late"]);
});

it.each(["abort", "owner", "generation"] as const)("honors %s between writer flush and the empty-frontier fast path", async boundary => {
  const frontier = (await pool()).create(vi.fn());
  await frontier.drain(async () => {});
  const controller = new AbortController();
  const finishing = frontier.drain(async () => {}, controller.signal);
  queueMicrotask(() => {
    if (boundary === "abort") controller.abort();
    else if (boundary === "owner") publishAuthOwnerChange("fastpath-replacement");
    else publishAuthGenerationChange(getAuthSessionSnapshot().generation + 1);
  });
  if (boundary === "abort") await expect(finishing).rejects.toMatchObject({ name: "AbortError" });
  else await expect(finishing).rejects.toThrow("search_spool_disposed");
});

it("retains an unacknowledged batch when the consumer fails and includes late earlier keys", async () => {
  const frontier = (await pool()).create(vi.fn());
  for (let i = 0; i < 130; i++) frontier.append(`initial-${i}`);
  await expect(frontier.drain(async () => { throw new Error("consumer"); })).rejects.toThrow("consumer");
  const seen = new Set<string>(); let first = true;
  await frontier.drain(async ids => { for (const id of ids) seen.add(id); if (first) { first = false; frontier.append("0-late"); } });
  expect(seen.size).toBe(131); expect(seen.has("0-late")).toBe(true);
});

it("cancels a drain without losing its unacknowledged IDs", async () => {
  const frontier = (await pool()).create(vi.fn()), controller = new AbortController();
  frontier.append("kept");
  await expect(frontier.drain(async () => { controller.abort(); }, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  const seen: string[] = []; await frontier.drain(async ids => { seen.push(...ids); });
  expect(seen).toEqual(["kept"]);
});

it("serializes all queued consumers behind an unfinished drain", async () => {
  const frontier = (await pool()).create(vi.fn());
  frontier.append("first");
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const first = frontier.drain(async () => { entered(); await gate; throw new Error("retry"); });
  const failed = expect(first).rejects.toThrow("retry");
  await started;
  const seen: string[] = [];
  let active = 0, peak = 0;
  const consume = async (ids: readonly string[]) => {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 10));
    seen.push(...ids); active--;
  };
  const second = frontier.drain(consume), third = frontier.drain(consume);
  release();
  await Promise.all([failed, second, third]);
  expect(peak).toBe(1);
  expect(seen).toEqual(["first"]);
});

it.each(["owner", "generation"] as const)("retires its pool and pending frontier on %s replacement", async boundary => {
  const writer = await pool(), frontier = writer.create(vi.fn()); frontier.append("retired");
  if (boundary === "owner") publishAuthOwnerChange("replacement"); else publishAuthGenerationChange(getAuthSessionSnapshot().generation + 1);
  expect(writer.closed).toBe(true); expect(() => frontier.append("late")).toThrow();
  await expect(frontier.drain(async () => {})).rejects.toThrow();
});

it("disposes its own rows without touching another frontier", async () => {
  const writer = await pool(), first = writer.create(vi.fn()), second = writer.create(vi.fn());
  first.append("first"); second.append("second"); await first.dispose();
  const seen: string[] = []; await second.drain(async ids => { seen.push(...ids); }); expect(seen).toEqual(["second"]);
  await second.dispose();
  const db = await openSearchDatabase(`${await getAccountDatabaseName("spool-owner", SERVER_URL)}.search.v1`);
  try { expect(await db.count("refs")).toBe(0); expect(await db.count("snapshots")).toBe(0); } finally { db.close(); }
});

it("reports native writer failure rather than acknowledging a missing deletion", async () => {
  const writer = await pool(), notify = vi.fn(), frontier = writer.create(notify);
  const original = IDBObjectStore.prototype.put;
  const hook = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args) {
    if (this.name === "refs") throw new DOMException("Synthetic spool quota", "QuotaExceededError");
    return original.apply(this, args);
  });
  try { expect(() => frontier.append("failed")).toThrow("Synthetic spool quota"); } finally { hook.mockRestore(); }
  await expect(frontier.drain(async () => {})).rejects.toMatchObject({ name: "QuotaExceededError" });
  expect(notify).toHaveBeenCalledOnce();
});
