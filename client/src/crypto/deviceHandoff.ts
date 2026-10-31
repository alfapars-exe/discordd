/** A version-2 retirement barrier fences even unpatched version-1 key writers.
 * No source records are deleted. Capsule output exists only after the durable
 * retirement marker and the encrypted capsule are committed together.
 */
import { openDB, type IDBPDatabase } from "idb";
import { x25519, ed25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { getAccountDatabaseName, KEY_DATABASE_STORES } from "./keyStorage";
import { getAuthSessionSnapshot } from "../api/authSessionEvents";
import { SERVER_URL } from "../utils/constants";
import { listMyDevices } from "../api/e2ee";

export type HandoffIntent = {
  version: 1;
  intentId: string;
  owner: string;
  backend: string;
  publicKey: string;
};
const markerKey = "device-handoff:v1",
  limit = 32 * 1024 * 1024;
const b64 = (bytes: Uint8Array) => {
  let out = "";
  for (let i = 0; i < bytes.length; i += 8192)
    out += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(out);
};
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
function parseIntent(json: string): HandoffIntent {
  const i = JSON.parse(json) as HandoffIntent;
  if (
    i.version !== 1 ||
    !/^[a-f0-9]{64}$/.test(i.intentId) ||
    !i.owner ||
    unb64(i.publicKey).length !== 32
  )
    throw Error("invalid_handoff_intent");
  x25519
    .getSharedSecret(new Uint8Array(32).fill(1), unb64(i.publicKey))
    .fill(0);
  const url = new URL(i.backend);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (!["https:", "app:"].includes(url.protocol) &&
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
  )
    throw Error("invalid_handoff_backend");
  return i;
}
async function encode(value: unknown, depth = 0): Promise<unknown> {
  if (depth > 64) throw Error("handoff_value_too_deep");
  if (value instanceof Uint8Array) return { __b64: b64(value) };
  if (value instanceof ArrayBuffer)
    return { __b64: b64(new Uint8Array(value)) };
  if (ArrayBuffer.isView(value))
    return {
      __b64: b64(
        new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
      ),
    };
  if (typeof CryptoKey !== "undefined" && value instanceof CryptoKey)
    throw Error("nonportable_key_requires_rewrap");
  if (value instanceof Blob)
    return {
      __file: {
        name: value instanceof File ? value.name : "",
        type: value.type,
        lastModified: value instanceof File ? value.lastModified : 0,
      },
      __b64: b64(new Uint8Array(await value.arrayBuffer())),
    };
  if (Array.isArray(value))
    return Promise.all(value.map((v) => encode(v, depth + 1)));
  if (value && typeof value === "object")
    return Object.fromEntries(
      await Promise.all(
        Object.entries(value).map(async ([k, v]) => [
          k,
          await encode(v, depth + 1),
        ]),
      ),
    );
  if (value === undefined) return null;
  if (typeof value === "number" && !Number.isFinite(value))
    throw Error("invalid_handoff_number");
  return value;
}
async function snapshot(db: IDBPDatabase, owner: string) {
  const tx = db.transaction([...KEY_DATABASE_STORES], "readonly");
  const rows: Record<string, Array<{ key: IDBValidKey; value: any }>> = {};
  await Promise.all(
    KEY_DATABASE_STORES.map(async (name) => {
      const store = tx.objectStore(name),
        [keys, values] = await Promise.all([
          store.getAllKeys(),
          store.getAll(),
        ]);
      rows[name] = keys.map((key, index) => ({ key, value: values[index] }));
    }),
  );
  await tx.done;
  const registration = rows.registration.find(
    (r) => r.key === "primary",
  )?.value;
  if (registration?.userId !== owner || !registration.deviceId)
    throw Error("handoff_account_mismatch");
  const identity = rows.identity.find((r) => r.key === "primary")?.value,
    signing = rows.signing.find((r) => r.key === "primary")?.value;
  if (
    !identity ||
    !signing ||
    b64(x25519.getPublicKey(identity.privateKey)) !== b64(identity.publicKey) ||
    b64(ed25519.getPublicKey(signing.privateKey)) !== b64(signing.publicKey)
  )
    throw Error("invalid_device_identity");
  const key32 = (v: unknown) => v instanceof Uint8Array && v.length === 32;
  const pair = (v: any) =>
    key32(v?.privateKey) &&
    key32(v?.publicKey) &&
    b64(x25519.getPublicKey(v.privateKey)) === b64(v.publicKey);
  const counter = (v: unknown) =>
    typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 0xffffffff;
  for (const row of [...rows.preKeys, ...rows.signedPreKeys]) {
    if (!pair(row.value)) throw Error("invalid_prekey");
  }
  for (const row of rows.signedPreKeys) {
    if (
      !ed25519.verify(
        row.value.signature,
        row.value.publicKey,
        signing.publicKey,
      )
    )
      throw Error("invalid_prekey_signature");
  }
  for (const row of rows.sessions) {
    const s = row.value.state;
    if (
      !s ||
      !key32(s.rootKey) ||
      !pair(s.sendingRatchetKeyPair) ||
      [s.sendingChainKey, s.receivingChainKey, s.receivingRatchetKey].some(
        (v) => v !== null && !key32(v),
      ) ||
      ![
        s.sendMessageNumber,
        s.receiveMessageNumber,
        s.previousSendChainLength,
      ].every(counter) ||
      !Array.isArray(s.skippedMessageKeys) ||
      s.skippedMessageKeys.length > 1000 ||
      s.skippedMessageKeys.some(
        (k: any) =>
          unb64(k.ratchetKey).length !== 32 ||
          !counter(k.messageNumber) ||
          !key32(k.messageKey),
      ) ||
      new Set(
        s.skippedMessageKeys.map((k: any) =>
          JSON.stringify([k.ratchetKey, k.messageNumber]),
        ),
      ).size !== s.skippedMessageKeys.length
    )
      throw Error("unsupported_session_state");
  }
  for (const row of rows.senderKeys) {
    const s = row.value;
    if (
      ![s.channelId, s.senderUserId, s.senderDeviceId, s.distributionId].every(
        (v) => typeof v === "string" && v.length > 0 && v.length <= 256,
      ) ||
      !key32(s.chainKey) ||
      !key32(s.publicSigningKey) ||
      (s.initialChainKey !== undefined && !key32(s.initialChainKey)) ||
      !counter(s.iteration) ||
      s.iteration > 1101 ||
      !Number.isSafeInteger(s.createdAt) ||
      s.createdAt < 0 ||
      (s.seenIterations !== undefined &&
        (!Array.isArray(s.seenIterations) ||
          s.seenIterations.length > 1024 ||
          s.seenIterations.some(
            (v: any, n: number, a: any[]) =>
              !counter(v) || (n > 0 && a[n - 1] >= v),
          )))
    )
      throw Error("unsupported_sender_key_state");
  }
  for (const row of rows.trustedIdentities)
    if (!key32(row.value.identityKey)) throw Error("invalid_trusted_identity");
  const metadata = new Map(rows.metadata.map((r) => [String(r.key), r.value]));
  const portablePending = [];
  for (const row of rows.metadata) {
    const name = String(row.key);
    if (!name.startsWith("group_pending:v1:")) continue;
    const tail = name.slice("group_pending:v1:".length),
      at = tail.indexOf("]:");
    if (at < 0) throw Error("invalid_pending_scope");
    const [account, device] = JSON.parse(tail.slice(0, at + 1)),
      [group, id] = JSON.parse(tail.slice(at + 2));
    if (account !== owner) throw Error("pending_account_mismatch");
    const key = metadata.get(
      `group_pending_key:v1:${JSON.stringify([account, device])}`,
    ) as CryptoKey;
    if (!key || key.extractable || key.algorithm.name !== "AES-GCM")
      throw Error("pending_key_missing");
    const env = row.value;
    const open = async (part: any, tag: string) => {
      const ad = new TextEncoder().encode(
        JSON.stringify([
          "hichat-group-pending-v1",
          account,
          device,
          group,
          id,
          tag,
        ]),
      );
      return new Uint8Array(
        await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: Uint8Array.from(part.iv), additionalData: ad },
          key,
          part.ciphertext,
        ),
      );
    };
    const manifest = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        await open(env.manifest, "manifest"),
      ),
    );
    if (
      manifest.accountId !== account ||
      manifest.deviceId !== device ||
      manifest.groupId !== group ||
      manifest.id !== id ||
      manifest.payload?.client_request_id !== id ||
      manifest.payload?.sender_device_id !== device
    )
      throw Error("pending_scope_mismatch");
    const parts: Record<string, string[]> = { files: [], encryptedFiles: [] };
    for (const kind of ["files", "encryptedFiles"]) {
      if (env[kind].length !== manifest[kind].length)
        throw Error("pending_file_mismatch");
      for (let n = 0; n < env[kind].length; n++) {
        const bytes = await open(env[kind][n], `${kind}:${n}`);
        if (bytes.length !== manifest[kind][n].size)
          throw Error("pending_file_mismatch");
        parts[kind].push(b64(bytes));
        bytes.fill(0);
      }
    }
    portablePending.push({ kind: "group", manifest, ...parts });
  }
  // Keys are replaced by the re-protected portable records, never exported raw.
  rows.metadata = rows.metadata.filter(
    (r) =>
      r.key !== markerKey &&
      !String(r.key).startsWith("group_pending_key:v1:") &&
      !String(r.key).startsWith("group_pending:v1:"),
  );
  return {
    registration,
    identityKey: b64(identity.publicKey),
    signingKey: b64(signing.publicKey),
    stores: await encode(rows),
    portablePending,
  };
}
export async function exportDeviceHandoff(
  intentJson: string,
  preferences: unknown = {},
): Promise<string> {
  const intent = parseIntent(intentJson),
    auth = getAuthSessionSnapshot();
  const canonical = (value: string) => {
    const u = new URL(value || location.origin);
    return u.origin + u.pathname.replace(/\/+$/, "");
  };
  if (auth.ownerId !== intent.owner || canonical(SERVER_URL) !== intent.backend)
    throw Error("handoff_account_mismatch");
  const current = () => {
    const a = getAuthSessionSnapshot();
    if (a.ownerId !== auth.ownerId || a.generation !== auth.generation)
      throw Error("handoff_scope_changed");
  };
  const name = await getAccountDatabaseName(intent.owner, SERVER_URL);
  current();
  // Preflight before the irreversible version barrier (including key rewrap).
  let db: IDBPDatabase | undefined;
  try {
    db = await openDB(name, 1);
    const preview = await snapshot(db, intent.owner);
    db.close();
    const measured = new TextEncoder().encode(
      JSON.stringify({ ...preview, preferences }),
    ).length;
    if (
      measured > limit - 65536 ||
      JSON.stringify(preferences).length > 4 * 1024 * 1024
    )
      throw Error("handoff_too_large");
    const devices = await listMyDevices();
    current();
    if (
      !devices.success ||
      !devices.data?.some(
        (d) =>
          d.device_id === preview.registration.deviceId &&
          d.identity_key === preview.identityKey &&
          ed25519.verify(
            unb64(d.signed_prekey_signature),
            unb64(d.signed_prekey),
            unb64(preview.signingKey),
          ),
      )
    )
      throw Error("registered_device_mismatch");
  } catch (e) {
    if (db) db.close();
    if (!(e instanceof DOMException && e.name === "VersionError")) throw e;
  }
  current();
  db = await new Promise<IDBPDatabase>((resolve, reject) => {
    let cancelled = false,
      settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const request = indexedDB.open(name, 2);
    request.onblocked = () => {
      timer = setTimeout(() => {
        cancelled = true;
        settled = true;
        reject(Error("handoff_other_clients_open"));
      }, 3000);
    };
    request.onupgradeneeded = () => {
      try {
        current();
        if (cancelled) throw Error("cancelled");
        const tx = request.transaction!;
        tx.objectStore("metadata").put({ phase: "frozen", intent }, markerKey);
      } catch {
        request.transaction?.abort();
      }
    };
    request.onerror = () => {
      clearTimeout(timer);
      if (!settled) reject(Error("handoff_upgrade_failed"));
    };
    request.onsuccess = () => {
      clearTimeout(timer);
      if (cancelled) {
        request.result.close();
        return;
      }
      settled = true;
      void import("idb").then(({ wrap }) => resolve(wrap(request.result)));
    };
  });
  try {
    current();
    const marker = await db.get("metadata", markerKey);
    if (
      !marker ||
      marker.intent.intentId !== intent.intentId ||
      marker.intent.publicKey !== intent.publicKey
    )
      throw Error("handoff_target_already_bound");
    if (marker.phase === "retired") return marker.capsule as string;
    const snap = await snapshot(db, intent.owner);
    current();
    const payload = {
      stores: snap.stores,
      portablePending: snap.portablePending,
      preferences,
      retirement: {
        state: "retired",
        databaseVersion: 2,
        intentId: intent.intentId,
      },
    };
    const plain = new TextEncoder().encode(JSON.stringify(payload));
    if (plain.length > limit) throw Error("handoff_too_large");
    const privateKey = crypto.getRandomValues(new Uint8Array(32)),
      ephemeralKey = b64(x25519.getPublicKey(privateKey)),
      salt = crypto.getRandomValues(new Uint8Array(32)),
      nonce = crypto.getRandomValues(new Uint8Array(12));
    const header = {
      version: intent.version,
      intentId: intent.intentId,
      owner: intent.owner,
      backend: intent.backend,
      sourceDeviceId: snap.registration.deviceId,
      targetPublicKey: intent.publicKey,
      ephemeralKey,
      salt: b64(salt),
      nonce: b64(nonce),
    };
    const ad = new TextEncoder().encode(
      JSON.stringify([
        "hichat-device-handoff-v1",
        intent.intentId,
        intent.owner,
        intent.backend,
        header.sourceDeviceId,
        intent.publicKey,
        ephemeralKey,
        header.salt,
      ]),
    );
    const secret = x25519.getSharedSecret(privateKey, unb64(intent.publicKey));
    const keyBytes = hkdf(sha256, secret, salt, ad, 32);
    privateKey.fill(0);
    secret.fill(0);
    const key = await crypto.subtle.importKey(
      "raw",
      keyBytes as BufferSource,
      "AES-GCM",
      false,
      ["encrypt"],
    );
    keyBytes.fill(0);
    let ciphertext: ArrayBuffer;
    try {
      ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: nonce, additionalData: ad },
        key,
        plain,
      );
    } finally {
      plain.fill(0);
    }
    current();
    const capsule = JSON.stringify({
      ...header,
      ciphertext: b64(new Uint8Array(ciphertext)),
    });
    const tx = db.transaction("metadata", "readwrite");
    const prior = await tx.store.get(markerKey);
    current();
    if (prior.phase === "retired") {
      await tx.done;
      return prior.capsule as string;
    }
    await tx.store.put({ phase: "retired", intent, capsule }, markerKey);
    await tx.done;
    current();
    return capsule;
  } finally {
    db.close();
  }
}
