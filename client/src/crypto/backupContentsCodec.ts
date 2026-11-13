import { fromBase64 } from "./signalProtocol";

export class InvalidBackupContentsError extends Error {
  constructor() { super("Invalid backup contents"); this.name = "InvalidBackupContentsError"; }
}

type Row = Record<string, unknown>;
function invalid(): never { throw new InvalidBackupContentsError(); }
function row(value: unknown): Row {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  return value as Row;
}
function strings(value: Row, fields: string[]) {
  for (const field of fields) if (typeof value[field] !== "string") invalid();
}
function numbers(value: Row, fields: string[]) {
  for (const field of fields) if (typeof value[field] !== "number" || !Number.isFinite(value[field])) invalid();
}
function bytes(value: Row, fields: string[]) {
  strings(value, fields);
  for (const field of fields) {
    try { fromBase64(value[field] as string); } catch { invalid(); }
  }
}
function rows(value: unknown, validate: (entry: Row) => void) {
  if (!Array.isArray(value)) return invalid();
  for (const entry of value) validate(row(entry));
}
function sessionBytes(value: unknown, depth = 0): void {
  if (depth > 256) invalid();
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) { for (const entry of value) sessionBytes(entry, depth + 1); return; }
  const entry = row(value);
  if ("__b64" in entry) { bytes(entry, ["__b64"]); return; }
  for (const child of Object.values(entry)) sessionBytes(child, depth + 1);
}

/** Validate serialized field types and byte encodings before restore touches storage. */
export function decodeBackupContents(json: string): BackupContents {
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { return invalid(); }
  const value = row(parsed);
  if (value.version !== 1) invalid();
  bytes(row(value.identity), ["publicKey", "privateKey"]);
  bytes(row(value.signing), ["publicKey", "privateKey"]);
  const registration = row(value.registration);
  strings(registration, ["userId", "deviceId"]);
  numbers(registration, ["registrationId"]);
  if (!Number.isSafeInteger(registration.registrationId) || (registration.registrationId as number) < 0) invalid();
  rows(value.signedPreKeys, entry => { numbers(entry, ["id", "createdAt"]); bytes(entry, ["publicKey", "privateKey", "signature"]); });
  // Early version-1 backups may omit one-time prekeys.
  if (value.preKeys !== undefined) rows(value.preKeys, entry => { numbers(entry, ["id"]); bytes(entry, ["publicKey", "privateKey"]); });
  rows(value.sessions, entry => {
    strings(entry, ["userId", "deviceId", "state"]);
    numbers(entry, ["createdAt", "updatedAt"]);
    try { sessionBytes(row(JSON.parse(entry.state as string))); } catch { invalid(); }
  });
  rows(value.senderKeys, entry => {
    strings(entry, ["channelId", "senderUserId", "senderDeviceId", "distributionId"]);
    bytes(entry, ["chainKey", "publicSigningKey"]);
    if (entry.initialChainKey !== undefined) bytes(entry, ["initialChainKey"]);
    numbers(entry, ["iteration", "createdAt"]);
    // Replay fields deliberately retain the existing normalization policy.
  });
  rows(value.trustedIdentities, entry => {
    strings(entry, ["userId", "deviceId"]); bytes(entry, ["identityKey"]); numbers(entry, ["firstSeen"]);
    if (typeof entry.verified !== "boolean") invalid();
  });
  if (value.nextPrekeyId !== undefined) numbers(value, ["nextPrekeyId"]);
  if (value.messageCache !== undefined) rows(value.messageCache, entry => {
    strings(entry, ["messageId", "channelId", "content"]); numbers(entry, ["timestamp"]);
    if (entry.dmChannelId !== null && typeof entry.dmChannelId !== "string") invalid();
    if (entry.encryptedSourceTag !== undefined) strings(entry, ["encryptedSourceTag"]);
    if (entry.fileKeys !== undefined) rows(entry.fileKeys, file => {
      strings(file, ["key", "iv", "filename", "mimeType", "digest"]); numbers(file, ["originalSize"]);
    });
  });
  return { ...value, preKeys: value.preKeys ?? [] } as BackupContents;
}

/** Backup contents before encryption — all E2EE keys and sessions. */
export type BackupContents = {
  version: number;
  identity: {
    publicKey: string; // base64
    privateKey: string; // base64
  };
  signing: {
    publicKey: string;
    privateKey: string;
  };
  registration: {
    registrationId: number;
    deviceId: string;
    userId: string;
  };
  signedPreKeys: Array<{
    id: number;
    publicKey: string;
    privateKey: string;
    signature: string;
    createdAt: number;
  }>;
  sessions: Array<{
    userId: string;
    deviceId: string;
    state: string; // JSON stringified SessionState (with base64 encoded bytes)
    createdAt: number;
    updatedAt: number;
  }>;
  senderKeys: Array<{
    channelId: string;
    senderUserId: string;
    senderDeviceId: string;
    distributionId: string;
    chainKey: string;
    /**
     * Iteration-0 anchor, OPTIONAL because a key genuinely may not have one:
     * sender keys stored before this field existed carry no anchor, and the
     * repair in channelEncryption is gated on that absence.
     *
     * Backups written before this was optional encode absence as "" rather
     * than omitting the key, so readers must treat the empty string as absent
     * too (security scan 2026-07-31 follow-up).
     */
    initialChainKey?: string;
    publicSigningKey: string;
    iteration: number;
    createdAt: number;
    /**
     * Replay-protection window for this distribution. Both fields are OPTIONAL
     * on purpose: backups written before they were carried simply lack them,
     * and normalizeReplayWindow turns absence into the safe "nothing evicted,
     * nothing seen" state. Additive-only, so BACKUP_VERSION stays 1 — an older
     * client restoring a newer backup ignores the extra JSON members.
     *
     * They must be carried at all because a restore that dropped them handed
     * the user back a key with an EMPTY window and a live iteration counter,
     * re-opening every ciphertext already accepted under this chain (security
     * scan 2026-07-31, finding N-11 on the backup path).
     */
    seenIterations?: unknown;
    replayFloor?: unknown;
  }>;
  /** One-time prekeys — critical for X3DH. Without them, PreKey messages
   *  can't be decrypted after restore (3-DH vs 4-DH mismatch). */
  preKeys: Array<{
    id: number;
    publicKey: string;
    privateKey: string;
  }>;
  trustedIdentities: Array<{
    userId: string;
    deviceId: string;
    identityKey: string;
    firstSeen: number;
    verified: boolean;
  }>;
  /** Prekey ID counter — prevents new prekeys from colliding with old IDs after restore */
  nextPrekeyId?: number;
  /** Decrypted message cache — allows reading old messages after restore */
  messageCache?: Array<{
    messageId: string;
    channelId: string;
    dmChannelId: string | null;
    content: string;
    timestamp: number;
    encryptedSourceTag?:string;
    fileKeys?:import("./fileEncryption").EncryptedFileMeta[];
  }>;
};

