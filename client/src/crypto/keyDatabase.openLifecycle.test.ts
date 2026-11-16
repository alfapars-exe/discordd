import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { publishAuthGenerationChange, publishAuthOwnerChange } from "../api/authSessionEvents";

const controlled = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("idb", async (importOriginal) => {
  const actual = await importOriginal<typeof import("idb")>();
  controlled.open.mockImplementation(actual.openDB);
  return { ...actual, openDB: controlled.open };
});
import { closeDB, getDB } from "./keyDatabase";
let generation = 14000;
beforeEach(async () => {
  await closeDB();
  globalThis.indexedDB = new IDBFactory();
  vi.clearAllMocks();
  publishAuthOwnerChange("open-lifecycle-owner");
  publishAuthGenerationChange(++generation);
});
afterEach(async () => { await closeDB(); });

it("evicts a failed opening so a later request can retry", async () => {
  const failure = new DOMException("controlled open failure", "UnknownError");
  controlled.open.mockRejectedValueOnce(failure);
  await expect(getDB()).rejects.toBe(failure);
  await expect(getDB()).resolves.toBeDefined();
  expect(controlled.open).toHaveBeenCalledTimes(2);
});

it("a retired blocking callback cannot evict the successor connection", async () => {
  await getDB();
  const blocking = controlled.open.mock.calls[0][2].blocking as () => void;
  await closeDB();
  await getDB();
  blocking();
  await getDB();
  expect(controlled.open).toHaveBeenCalledTimes(2);
});

it("a retired failed opening cannot evict a successor", async () => {
  let reject!: (error: Error) => void;
  controlled.open.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
  const stale = getDB();
  const rejected = expect(stale).rejects.toThrow("retired open");
  await vi.waitFor(() => expect(controlled.open).toHaveBeenCalledTimes(1));
  await closeDB();
  await getDB();
  reject(new Error("retired open"));
  await rejected;
  await getDB();
  expect(controlled.open).toHaveBeenCalledTimes(2);
});
