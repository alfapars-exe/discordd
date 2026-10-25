import "fake-indexeddb/auto";
import { IDBFactory as FakeIDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it } from "vitest";
import { publishAuthGenerationChange, publishAuthOwnerChange } from "../api/authSessionEvents";
import * as keyStorage from "./keyStorage";

const backend = "https://scope-test.example";
let generation = 9000;

async function setOwner(ownerId: string | null): Promise<void> {
  publishAuthOwnerChange(ownerId);
  publishAuthGenerationChange(++generation);
  await Promise.resolve();
}

afterEach(async () => {
  await keyStorage.closeDB();
  publishAuthOwnerChange(null);
  publishAuthGenerationChange(++generation);
});

describe("keyStorage account/backend scope", () => {
  it("derives distinct deterministic names for owner and backend, outside the legacy namespace", async () => {
    const a = await keyStorage.getAccountDatabaseName("account-a", backend);
    expect(a).toMatch(/^mqvi_e2ee\.account\.v1\.[0-9a-f]{64}$/);
    expect(await keyStorage.getAccountDatabaseName("account-a", backend)).toBe(a);
    expect(await keyStorage.getAccountDatabaseName("account-b", backend)).not.toBe(a);
    expect(await keyStorage.getAccountDatabaseName("account-a", "https://other.example")).not.toBe(a);
    expect(a).not.toBe("mqvi_e2ee");
  });

  it("fails closed without an authenticated owner", async () => {
    await setOwner(null);
    await expect(keyStorage.getMetadata("private")).rejects.toThrow("e2ee_account_scope_unavailable");
    await expect(keyStorage.setMetadata("private", "value")).rejects.toThrow("e2ee_account_scope_unavailable");
  });

  it("keeps records isolated when the authenticated owner changes", async () => {
    await setOwner("account-a");
    await keyStorage.setMetadata("scope-test", "A");
    await setOwner("account-b");
    expect(await keyStorage.getMetadata("scope-test")).toBeNull();
    await keyStorage.setMetadata("scope-test", "B");
    await setOwner("account-a");
    expect(await keyStorage.getMetadata("scope-test")).toBe("A");
  });

  it("rejects an operation whose owner changes while its database is opening", async () => {
    await setOwner("account-a");
    const staleWrite = keyStorage.setMetadata("opening-race", "A");
    publishAuthOwnerChange("account-b");
    publishAuthGenerationChange(++generation);
    await expect(staleWrite).rejects.toThrow("e2ee_account_scope_changed");
    expect(await keyStorage.getMetadata("opening-race")).toBeNull();
  });

  it("rejects a read result when auth generation changes after the read starts", async () => {
    await setOwner("account-a");
    await keyStorage.setMetadata("read-race", "private");
    const staleRead = keyStorage.getMetadata("read-race");
    publishAuthGenerationChange(++generation);
    await expect(staleRead).rejects.toThrow("e2ee_account_scope_changed");
  });

  it("aborts an active write transaction on an owner boundary, even without a caller guard", async () => {
    await setOwner("account-a");
    const db = await keyStorage.openScopedKeyDatabase("account-a", backendForRuntime());
    const tx = db.transaction("metadata", "readwrite");
    const put = tx.store.put("must-not-commit", "transaction-race");
    publishAuthOwnerChange("account-b");
    publishAuthGenerationChange(++generation);
    await expect(put).rejects.toThrow();
    await expect(tx.done).rejects.toThrow();
    expect(await keyStorage.getMetadata("transaction-race")).toBeNull();
  });

  it("does not read, write, or delete the legacy global database", async () => {
    const factory = new FakeIDBFactory();
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = factory;
    const legacyOpen = factory.open("mqvi_e2ee", 1);
    legacyOpen.onupgradeneeded = () => legacyOpen.result.createObjectStore("metadata");
    const legacyDb = await new Promise<IDBDatabase>((resolve, reject) => {
      legacyOpen.onsuccess = () => resolve(legacyOpen.result);
      legacyOpen.onerror = () => reject(legacyOpen.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = legacyDb.transaction("metadata", "readwrite");
      tx.objectStore("metadata").put("legacy-value", "probe");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    await setOwner("account-a");
    expect(await keyStorage.getMetadata("probe")).toBeNull();
    await keyStorage.setMetadata("probe", "account-value");
    const tx = legacyDb.transaction("metadata", "readonly");
    expect(await new Promise((resolve, reject) => {
      const request = tx.objectStore("metadata").get("probe");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    })).toBe("legacy-value");
    legacyDb.close();
  });
});

function backendForRuntime(): string {
  return typeof location !== "undefined" ? location.origin : backend;
}
