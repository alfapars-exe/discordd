import * as keyStorage from "./keyStorage";
import { normalizeReplayWindow } from "./senderKeyProtocol";
import { toBase64, fromBase64 } from "./signalProtocol";
import { serializeBackupSessionState, decodeBackupSessionState } from "./backupSessionCodec";
import { BACKUP_VERSION, type BackupContents } from "./backupContentsCodec";
import { assertCurrent, isCurrent, awaitScoped, type AuthScope } from "./backupAuthScope";

/**
 * Decodes a sender key's iteration-0 anchor from a backup, preserving absence.
 *
 * Two encodings mean "this key has no anchor": the field missing (what the
 * serializer writes now) and the empty string (what backups written before it
 * became optional carry). The falsy check covers both, and it has to happen
 * BEFORE decoding: `fromBase64("")` returns a zero-length Uint8Array, every
 * object is truthy in JS, and `!existingKey.initialChainKey` would therefore
 * be false for it — indistinguishable from a real anchor to the repair gate in
 * channelEncryption, which is the exact failure this change removes.
 *
 * No length check on the decoded bytes: the only writer of this field is the
 * serializer above, and the backup is AEAD-authenticated as a whole, so a
 * value that decodes to nothing cannot reach here from a tampered file either.
 * A guard for that case was written first and removed — a mutation showed no
 * test could tell whether it was there, because nothing can reach it.
 */
function decodeAnchor(encoded: string | undefined): Uint8Array | undefined {
  return encoded ? fromBase64(encoded) : undefined;
}

/** Collect all E2EE data from IndexedDB. */
export async function collectBackupContents(scope: AuthScope): Promise<BackupContents> {
  const identity = await awaitScoped(scope, () => keyStorage.getIdentityKeyPair());
  const signing = await awaitScoped(scope, () => keyStorage.getSigningKeyPair());
  const registration = await awaitScoped(scope, () => keyStorage.getRegistrationData());

  if (!identity || !signing || !registration) {
    throw new Error("E2EE keys not initialized — cannot create backup");
  }
  if (registration.userId !== scope.ownerId) throw new Error("E2EE registration does not match authenticated account");

  const signedPreKeys = await awaitScoped(scope, () => keyStorage.getAllSignedPreKeys());
  const preKeys = await awaitScoped(scope, () => keyStorage.getAllPreKeys());
  const sessions = await awaitScoped(scope, () => keyStorage.getAllSessions());
  const senderKeys = await awaitScoped(scope, () => keyStorage.getAllSenderKeys());
  const trustedIdentities = await awaitScoped(scope, () => keyStorage.getAllTrustedIdentities());
  const cachedMessages = await awaitScoped(scope, () => keyStorage.getAllCachedMessages());
  const nextPrekeyId = await awaitScoped(scope, () => keyStorage.getMetadata<number>("nextPrekeyId"));
  assertCurrent(scope);

  return {
    version: BACKUP_VERSION,
    identity: {
      publicKey: toBase64(identity.publicKey),
      privateKey: toBase64(identity.privateKey),
    },
    signing: {
      publicKey: toBase64(signing.publicKey),
      privateKey: toBase64(signing.privateKey),
    },
    registration: {
      registrationId: registration.registrationId,
      deviceId: registration.deviceId,
      userId: registration.userId,
    },
    signedPreKeys: signedPreKeys.map((spk) => ({
      id: spk.id,
      publicKey: toBase64(spk.publicKey),
      privateKey: toBase64(spk.privateKey),
      signature: toBase64(spk.signature),
      createdAt: spk.createdAt,
    })),
    preKeys: preKeys.map((pk) => ({
      id: pk.id,
      publicKey: toBase64(pk.publicKey),
      privateKey: toBase64(pk.privateKey),
    })),
    sessions: sessions.map((s) => ({
      userId: s.userId,
      deviceId: s.deviceId,
      state: JSON.stringify(serializeBackupSessionState(s.state)),
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    })),
    senderKeys: senderKeys.map((sk) => ({
      channelId: sk.channelId,
      senderUserId: sk.senderUserId,
      senderDeviceId: sk.senderDeviceId,
      distributionId: sk.distributionId,
      chainKey: toBase64(sk.chainKey),
      // Omitted, not "", when the key has no anchor. The old "" encoding was
      // indistinguishable from a present-but-empty value on the way back in.
      ...(sk.initialChainKey ? { initialChainKey: toBase64(sk.initialChainKey) } : {}),
      publicSigningKey: toBase64(sk.publicSigningKey),
      iteration: sk.iteration,
      createdAt: sk.createdAt,
      seenIterations: sk.seenIterations,
      replayFloor: sk.replayFloor,
    })),
    trustedIdentities: trustedIdentities.map((ti) => ({
      userId: ti.userId,
      deviceId: ti.deviceId,
      identityKey: toBase64(ti.identityKey),
      firstSeen: ti.firstSeen,
      verified: ti.verified,
    })),
    nextPrekeyId: nextPrekeyId ?? undefined,
    messageCache: cachedMessages.map((m) => ({
      messageId: m.messageId,
      channelId: m.channelId,
      dmChannelId: m.dmChannelId,
      content: m.content,
      timestamp: m.timestamp,
      encryptedSourceTag:m.encryptedSourceTag,
      fileKeys:m.fileKeys,
    })),
  };
}

/** Import backup contents into IndexedDB.
 *
 * Atomicity note: writing into IndexedDB inherently happens in
 * transactions, but the *sequence* of writes here spans many separate
 * transactions. The earlier implementation called clearAllE2EEData() and
 * THEN wrote — which meant a crash, tab close, or quota exhaustion between
 * the clear and a later write left the user with partial (or zero) E2EE
 * data, requiring another full restore from backup. The fix:
 *
 *   1. Snapshot current data (ALL stores clearAllE2EEData touches, metadata
 *      included) into memory first.
 *   2. Validate the entire backup decodes cleanly (catches bad b64 etc.)
 *      before mutating any store.
 *   3. Wipe + write in the existing order (still not atomic across stores;
 *      if anything fails we replay the snapshot on a best-effort basis —
 *      see the catch block for exactly how far that guarantee reaches).
 *
 * The snapshot is held in memory for the duration of the import — for a
 * typical backup (<1MB serialized) this is fine; if backups grow to many
 * megabytes the snapshot path can be revisited.
 */
export async function importBackupContents(contents: BackupContents, scope: AuthScope): Promise<void> {
  assertCurrent(scope);
  if (contents.registration.userId !== scope.ownerId) throw new Error("Backup account does not match authenticated account");
  // Preserve existing message cache — previously decrypted messages must remain
  // readable since ratchet state may have changed after restore
  const existingCache = await awaitScoped(scope, () => keyStorage.getAllCachedMessages());

  // Snapshot the current crypto state so we can roll back on failure.
  // Reading these up-front catches IDB read errors before we wipe anything.
  const snapshot = {
    identity: await awaitScoped(scope, () => keyStorage.getIdentityKeyPair()),
    signing: await awaitScoped(scope, () => keyStorage.getSigningKeyPair()),
    registration: await awaitScoped(scope, () => keyStorage.getRegistrationData()),
    signedPreKeys: await awaitScoped(scope, () => keyStorage.getAllSignedPreKeys()),
    preKeys: await awaitScoped(scope, () => keyStorage.getAllPreKeys()),
    sessions: await awaitScoped(scope, () => keyStorage.getAllSessions()),
    senderKeys: await awaitScoped(scope, () => keyStorage.getAllSenderKeys()),
    trustedIdentities: await awaitScoped(scope, () => keyStorage.getAllTrustedIdentities()),
    // clearAllE2EEData() wipes the metadata store too, and a rollback that
    // skipped it left the device with keys but no "deviceId": getLocalDeviceId
    // reads ONLY that entry, hasLocalKeys never looks at it, so E2EE reported
    // itself ready while every DM decrypt bailed on a null local device id and
    // nothing ever re-registered. Snapshotting the whole store rather than a
    // list of known keys also covers sk_signing:*/prekey_info:*/legacyDeviceIds,
    // whose key space is open-ended (security scan 2026-07-31, finding N-22).
    metadata: await awaitScoped(scope, () => keyStorage.getAllMetadata()),
  };

  try {
    // Clear crypto keys (including messageCache — will be re-written below)
    await awaitScoped(scope, () => keyStorage.clearAllE2EEData({ resetSelfFanout: true }));

    // Identity key pair
    await awaitScoped(scope, () => keyStorage.saveIdentityKeyPair({
      publicKey: fromBase64(contents.identity.publicKey),
      privateKey: fromBase64(contents.identity.privateKey),
    }));

    // Signing key pair
    await awaitScoped(scope, () => keyStorage.saveSigningKeyPair({
      publicKey: fromBase64(contents.signing.publicKey),
      privateKey: fromBase64(contents.signing.privateKey),
    }));

    // Registration data
    await awaitScoped(scope, () => keyStorage.saveRegistrationData({
      registrationId: contents.registration.registrationId,
      deviceId: contents.registration.deviceId,
      userId: contents.registration.userId,
      createdAt: Date.now(),
    }));

    // Write deviceId to metadata store — getLocalDeviceId() reads from here.
    // Without this, localDeviceId stays null after restore → device management breaks.
    await awaitScoped(scope, () => keyStorage.setMetadata("deviceId", contents.registration.deviceId));

    // Restore nextPrekeyId to prevent new prekeys from overwriting old private keys
    if (contents.nextPrekeyId) {
      await awaitScoped(scope, () => keyStorage.setMetadata("nextPrekeyId", contents.nextPrekeyId!));
    }

    // Signed prekeys
    for (const spk of contents.signedPreKeys) {
      await awaitScoped(scope, () => keyStorage.saveSignedPreKey({
        id: spk.id,
        publicKey: fromBase64(spk.publicKey),
        privateKey: fromBase64(spk.privateKey),
        signature: fromBase64(spk.signature),
        createdAt: spk.createdAt,
      }));
    }

    // One-time prekeys — critical for X3DH
    if (contents.preKeys && contents.preKeys.length > 0) {
      await awaitScoped(scope, () => keyStorage.savePreKeys(
        contents.preKeys.map((pk) => ({
          id: pk.id,
          publicKey: fromBase64(pk.publicKey),
          privateKey: fromBase64(pk.privateKey),
        })),
      ));
    }

    // Sessions
    for (const s of contents.sessions) {
      const state = decodeBackupSessionState(s.state);
      await awaitScoped(scope, () => keyStorage.saveSession({
        userId: s.userId,
        deviceId: s.deviceId,
        state,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
      }));
    }

    // Sender keys
    for (const sk of contents.senderKeys) {
      // The window comes off a JSON.parse, so it is normalized rather than
      // trusted: isReplay binary-searches and would silently miss hits on an
      // unsorted or poisoned array. Absent (older backup) normalizes to the
      // safe empty window with floor 0.
      const window = normalizeReplayWindow(sk.seenIterations, sk.replayFloor);
      await awaitScoped(scope, () => keyStorage.saveSenderKey({
        channelId: sk.channelId,
        senderUserId: sk.senderUserId,
        senderDeviceId: sk.senderDeviceId,
        distributionId: sk.distributionId,
        chainKey: fromBase64(sk.chainKey),
        // Carry a real absence through instead of substituting chainKey.
        //
        // chainKey is the CURRENT ratcheted key; for anything past iteration 0
        // it is not the anchor. Rewinding from it derives the wrong message
        // keys, so restored history decrypts to garbage and renders as
        // content: null. The lasting damage is worse than the lost messages:
        // channelEncryption's repair is gated on !existingKey.initialChainKey,
        // so a fabricated anchor is truthy and shuts that door permanently.
        // Absence makes the rewind throw instead — a loud, recoverable failure
        // that the repair can still fix later.
        //
        // decodeAnchor also maps "" to undefined, which is how backups written
        // before the field became optional encoded absence: fromBase64("")
        // returns a zero-length Uint8Array, an object, therefore TRUTHY — so
        // decoding the old encoding literally would reproduce the same bug.
        initialChainKey: decodeAnchor(sk.initialChainKey),
        publicSigningKey: fromBase64(sk.publicSigningKey),
        iteration: sk.iteration,
        createdAt: sk.createdAt,
        seenIterations: window.seenIterations,
        replayFloor: window.replayFloor,
      }));
    }

    // Trusted identities
    for (const ti of contents.trustedIdentities) {
      await awaitScoped(scope, () => keyStorage.saveTrustedIdentity({
        userId: ti.userId,
        deviceId: ti.deviceId,
        identityKey: fromBase64(ti.identityKey),
        firstSeen: ti.firstSeen,
        verified: ti.verified,
      }));
    }

    // Merge existing cache + backup cache (existing takes priority)
    const existingIds = new Set(existingCache.map((m) => m.messageId));
    const mergedCache = [...existingCache];

    if (contents.messageCache) {
      for (const m of contents.messageCache) {
        if (!existingIds.has(m.messageId)) {
          mergedCache.push({
            messageId: m.messageId,
            channelId: m.channelId,
            dmChannelId: m.dmChannelId,
            content: m.content,
            timestamp: m.timestamp,
            encryptedSourceTag:m.encryptedSourceTag,
            fileKeys:m.fileKeys,
          });
        }
      }
    }

    if (mergedCache.length > 0) {
      await awaitScoped(scope, () => keyStorage.cacheDecryptedMessages(mergedCache));
    }
  } catch (err) {
    if (!isCurrent(scope)) throw new Error("e2ee_account_scope_changed", { cause: err });
    // Restore failed mid-write. Roll back from the snapshot toward the
    // pre-restore state.
    //
    // "Toward", not "to": IndexedDB gives us no transaction spanning these
    // stores, so the rollback is best-effort and can itself fail partway. Each
    // write is therefore isolated (see rollbackWrite) — one rejected write no
    // longer abandons every write after it, which is how a single failure used
    // to cost the user their whole key set — and the stores are replayed in
    // blast-radius order, metadata first: losing "deviceId" alone silently
    // kills every DM decrypt with no self-healing path
    // (security scan 2026-07-31, finding N-22).
    //
    // Whatever the rollback could not write is reported below rather than
    // swallowed; the user can still re-enter their recovery password to retry.
    // Storage error messages/properties can contain key or metadata values.
    console.error("[keyBackup] restore failed; rolling back to snapshot");
    const failedStores: string[] = [];

    await rollbackWrite(scope, failedStores, "clear", () => keyStorage.clearAllE2EEData());
    for (const [key, value] of snapshot.metadata) {
      await rollbackWrite(scope, failedStores, "metadata", () =>
        keyStorage.setMetadata(key, value)
      );
    }
    if (snapshot.identity) {
      const identity = snapshot.identity;
      await rollbackWrite(scope, failedStores, "identity", () =>
        keyStorage.saveIdentityKeyPair(identity)
      );
    }
    if (snapshot.signing) {
      const signing = snapshot.signing;
      await rollbackWrite(scope, failedStores, "signing", () =>
        keyStorage.saveSigningKeyPair(signing)
      );
    }
    if (snapshot.registration) {
      const registration = snapshot.registration;
      await rollbackWrite(scope, failedStores, "registration", () =>
        keyStorage.saveRegistrationData(registration)
      );
    }
    for (const spk of snapshot.signedPreKeys) {
      await rollbackWrite(scope, failedStores, "signedPreKeys", () =>
        keyStorage.saveSignedPreKey(spk)
      );
    }
    if (snapshot.preKeys.length > 0) {
      await rollbackWrite(scope, failedStores, "preKeys", () =>
        keyStorage.savePreKeys(snapshot.preKeys)
      );
    }
    for (const ses of snapshot.sessions) {
      await rollbackWrite(scope, failedStores, "sessions", () =>
        keyStorage.saveSession(ses)
      );
    }
    for (const sk of snapshot.senderKeys) {
      await rollbackWrite(scope, failedStores, "senderKeys", () =>
        keyStorage.saveSenderKey(sk)
      );
    }
    for (const ti of snapshot.trustedIdentities) {
      await rollbackWrite(scope, failedStores, "trustedIdentities", () =>
        keyStorage.saveTrustedIdentity(ti)
      );
    }
    if (existingCache.length > 0) {
      await rollbackWrite(scope, failedStores, "messageCache", () =>
        keyStorage.cacheDecryptedMessages(existingCache)
      );
    }

    if (failedStores.length > 0) {
      // Store names only. Metadata VALUES include the sender-key signing
      // private keys and metadata KEYS name channels/users, so neither may
      // reach the console.
      const stores = [...new Set(failedStores)].join(", ");
      console.error(
        `[keyBackup] rollback incomplete: ${failedStores.length} write(s) failed in ${stores}`
      );
    }
    throw err;
  }
}

/**
 * Perform one rollback write, recording the store name if it fails.
 *
 * Error-collection strategy: swallow-and-continue, aggregate-and-report. The
 * alternative (let the first failure propagate) is what shipped before, and it
 * means an error while writing, say, a single sender key throws away the
 * identity key, the metadata and everything else still queued — turning a
 * partial failure into a total one. Nothing here can be retried usefully in
 * the moment (the same quota/IDB fault would hit the retry), so the writes are
 * pushed as far as they go and the shortfall is logged once.
 */
async function rollbackWrite(
  scope: AuthScope,
  failedStores: string[],
  storeName: string,
  write: () => Promise<void>
): Promise<void> {
  if (!isCurrent(scope)) return;
  try {
    await write();
    assertCurrent(scope);
  } catch {
    if (!isCurrent(scope)) return;
    failedStores.push(storeName);
    console.error(`[keyBackup] rollback write failed for ${storeName}`);
  }
}

