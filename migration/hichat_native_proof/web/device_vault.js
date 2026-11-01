// Private target storage: encrypted records + non-exportable per-scope key.
// A Web Lock lives for the owner's entire lifetime; no expiring lease/split brain.
(() => {
  const handles = new Map();
  let next = 1;
  const request = (r) =>
    new Promise((resolve, reject) => {
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  const done = (tx) =>
    new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error || Error("VAULT_TRANSACTION_ABORTED"));
      tx.onerror = () => {};
    });
  async function database() {
    const r = indexedDB.open("hichat-target-device-vault-v1", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("records");
    return request(r);
  }
  function get(id) {
    const h = handles.get(id);
    if (!h || h.closed) throw Error("DEVICE_STORE_CLOSED");
    return h;
  }
  async function row(h) {
    const tx = h.db.transaction("records", "readonly"),
      complete = done(tx);
    const value = await request(tx.objectStore("records").get(h.scope));
    await complete;
    return value;
  }
  const aad = (scope, revision) =>
    new TextEncoder().encode(
      JSON.stringify(["hichat-target-device-vault-v1", scope, revision]),
    );
  window.hichatDeviceVault = {
    acquire(scope) {
      return new Promise((resolve, reject) => {
        if (!navigator.locks || !crypto.subtle || !indexedDB) {
          reject(Error("EXCLUSIVE_DEVICE_STORAGE_UNAVAILABLE"));
          return;
        }
        navigator.locks
          .request(
            "hichat-device-owner:" + scope,
            { mode: "exclusive", ifAvailable: true },
            async (lock) => {
              if (!lock) throw Error("DEVICE_OWNER_BUSY");
              const db = await database();
              const id = next++,
                h = { scope, db, closed: false, release: null };
              const released = new Promise((r) => (h.release = r));
              try {
                let existing = await row(h);
                if (!existing) {
                  const key = await crypto.subtle.generateKey(
                    { name: "AES-GCM", length: 256 },
                    false,
                    ["encrypt", "decrypt"],
                  );
                  const tx = db.transaction("records", "readwrite"),
                    complete = done(tx);
                  tx.objectStore("records").add(
                    { key, revision: 0, sealed: null },
                    scope,
                  );
                  await complete;
                }
                handles.set(id, h);
                resolve(id);
                await released;
              } finally {
                db.close();
                handles.delete(id);
              }
            },
          )
          .catch(reject);
      });
    },
    async load(id) {
      const h = get(id),
        r = await row(h);
      if (!r.sealed) return "null";
      if (r.sealed.byteLength > 96 * 1024 * 1024)
        throw Error("VAULT_TOO_LARGE");
      const plain = new Uint8Array(
        await crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: r.iv,
            additionalData: aad(h.scope, r.revision),
          },
          r.key,
          r.sealed,
        ),
      );
      try {
        get(id);
        return new TextDecoder("utf-8", { fatal: true }).decode(plain);
      } finally {
        plain.fill(0);
      }
    },
    async save(id, json) {
      if (json.length > 96 * 1024 * 1024) throw Error("VAULT_TOO_LARGE");
      const h = get(id),
        r = await row(h);
      const iv = crypto.getRandomValues(new Uint8Array(12)),
        plain = new TextEncoder().encode(json);
      if (plain.length > 96 * 1024 * 1024) {
        plain.fill(0);
        throw Error("VAULT_TOO_LARGE");
      }
      let sealed;
      try {
        sealed = await crypto.subtle.encrypt(
          { name: "AES-GCM", iv, additionalData: aad(h.scope, r.revision + 1) },
          r.key,
          plain,
        );
      } finally {
        plain.fill(0);
      }
      get(id);
      const tx = h.db.transaction("records", "readwrite"),
        complete = done(tx);
      const current = await request(tx.objectStore("records").get(h.scope));
      if (current.revision !== r.revision) {
        tx.abort();
        await complete.catch(() => {});
        throw Error("STALE_DEVICE_REVISION");
      }
      tx.objectStore("records").put(
        { key: r.key, revision: r.revision + 1, iv, sealed },
        h.scope,
      );
      await complete;
      return "ok";
    },
    async release(id) {
      const h = handles.get(id);
      if (!h || h.closed) return "ok";
      h.closed = true;
      h.release();
      return "ok";
    },
  };
})();
