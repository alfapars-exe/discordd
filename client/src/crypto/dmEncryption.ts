/**
 * DM Encryption — E2EE encrypt/decrypt layer for DM messages.
 *
 * Used by dmStore (sending) and useWebSocket (receiving).
 * Uses Signal Protocol primitives:
 * - Send: plaintext → EncryptedEnvelope[] (one per recipient device)
 * - Receive: EncryptedEnvelope[] → plaintext (for this device)
 *
 * Self-fanout: sender encrypts for own other devices so all
 * devices can see sent messages.
 *
 * On first message, recipient's prekey bundle is fetched and
 * X3DH session is established. Subsequent messages use existing
 * Double Ratchet session.
 */

import * as signalProtocol from "./signalProtocol";
import * as e2eeApi from "../api/e2ee";
import { logToServer } from "../api/clientLog";
import * as keyStorage from "./keyStorage";
import * as deviceManager from "./deviceManager";
import { decodePayload, type E2EEPayload } from "./e2eePayload";
import { useE2EEStore } from "../stores/e2eeStore";
import type { EncryptedEnvelope, PreKeyBundleResponse, DMMessage } from "../types";
import type { SignalWireMessage } from "./types";

// ──────────────────────────────────
// Sent Message Plaintext Cache
// ──────────────────────────────────

/**
 * FIFO plaintext cache for sent DM messages.
 *
 * Signal Protocol cannot create an envelope for the sender's own device
 * (no Double Ratchet session to self). So on WS echo, the sender cannot
 * decrypt its own message.
 *
 * Solution (Signal Desktop / WhatsApp model):
 * Plaintext is pushed to an in-memory FIFO queue BEFORE the API call.
 * On WS echo, it's popped from the queue. After API response, it's
 * persisted to IndexedDB for historical message access.
 *
 * Two-phase cache:
 * 1. preSendQueue: channelId → E2EEPayload[] (FIFO) — pushed before API call
 * 2. IndexedDB messageCache: messageId → content — persisted after API response
 *
 * No race condition: preSendQueue is set synchronously before the API call,
 * and WS echo only arrives after the server processes the message.
 */
const preSendQueue = new Map<string, E2EEPayload[]>();

/** In-memory cache for edit operations. messageId is known, so a direct Map suffices. */
const editCache = new Map<string, E2EEPayload>();

// ──────────────────────────────────
// Self-Fanout Reset Lock
// ──────────────────────────────────

/**
 * Serializes the self-fanout reset block (audit P0-FE-03).
 *
 * The "self_fanout_reset" flag drives a read-check-act sequence: read the
 * flag → delete every self-device session → re-handshake → clear the flag.
 * Two overlapping sends would both observe the armed flag, so the second
 * would delete the session the first just re-established — yielding an
 * envelope the sibling device cannot decrypt and burning a second one-time
 * prekey. Serializing makes the whole sequence atomic w.r.t. other sends.
 *
 * Deliberately NOT covered (each would need a different mechanism):
 * - Cross-tab races. The flag lives in IndexedDB, shared by every tab; this
 *   lock is per-JS-context. Closing that needs the Web Locks API.
 * - Recipient-session ratchet races. Concurrent sends to the same recipient
 *   device still advance the Double Ratchet in an arbitrary order; that
 *   needs per-conversation serialization, which would also cost the
 *   parallelism of encrypting for many recipient devices at once.
 */
let selfFanoutLock: Promise<unknown> = Promise.resolve();

function withSelfFanoutLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = selfFanoutLock.catch(() => {}).then(fn);
  // Chain on the swallowed form: one failed send must not poison the queue.
  selfFanoutLock = run.catch(() => {});
  return run;
}

/** Push plaintext to FIFO queue before API call, so WS echo can find it. */
export function pushSentPlaintext(dmChannelId: string, payload: E2EEPayload): void {
  const queue = preSendQueue.get(dmChannelId);
  if (queue) {
    queue.push(payload);
  } else {
    preSendQueue.set(dmChannelId, [payload]);
  }
}

/** Pop own message plaintext from FIFO on WS echo. Order is preserved by server. */
export function popSentPlaintext(dmChannelId: string): E2EEPayload | null {
  const queue = preSendQueue.get(dmChannelId);
  if (!queue || queue.length === 0) return null;

  const payload = queue.shift()!;
  if (queue.length === 0) preSendQueue.delete(dmChannelId);
  return payload;
}

/** Remove last queued entry on send failure (LIFO — failed send's push is last). */
export function discardLastSentPlaintext(dmChannelId: string): void {
  const queue = preSendQueue.get(dmChannelId);
  if (!queue || queue.length === 0) return;

  queue.pop();
  if (queue.length === 0) preSendQueue.delete(dmChannelId);
}

/** Cache plaintext before edit API call. */
export function cacheEditPlaintext(messageId: string, payload: E2EEPayload): void {
  editCache.set(messageId, payload);
}

/** Pop plaintext from edit cache. */
export function popEditPlaintext(messageId: string): E2EEPayload | null {
  const payload = editCache.get(messageId) ?? null;
  if (payload) editCache.delete(messageId);
  return payload;
}

/** Persist plaintext to IndexedDB after API response for historical access. */
export async function persistSentPlaintext(
  messageId: string,
  dmChannelId: string,
  content: string
): Promise<void> {
  await keyStorage.cacheDecryptedMessage({
    messageId,
    channelId: "",
    dmChannelId,
    content,
    timestamp: Date.now(),
  });
}

// ──────────────────────────────────
// Encryption (Sender Side)
// ──────────────────────────────────

/**
 * Encrypt a DM message for all recipient devices + self-fanout.
 *
 * 1. Fetch recipient's prekey bundles
 * 2. Encrypt for each recipient device (X3DH + Double Ratchet)
 * 3. Encrypt for sender's other devices (self-fanout)
 * 4. Returns EncryptedEnvelope[] to be JSON-serialized as ciphertext
 */
export async function encryptDMMessage(
  currentUserId: string,
  recipientUserId: string,
  localDeviceId: string,
  plaintext: string
): Promise<EncryptedEnvelope[]> {
  const envelopes: EncryptedEnvelope[] = [];

  // Fetch all recipient device bundles
  const recipientBundles = await e2eeApi.fetchPreKeyBundles(recipientUserId);
  if (!recipientBundles.success || !recipientBundles.data) {
    throw new Error("Failed to fetch recipient prekey bundles");
  }

  // Recipient has no devices/keys — hasn't set up E2EE yet
  if (recipientBundles.data.length === 0) {
    throw new Error("RECIPIENT_NO_KEYS");
  }

  // Snapshot of the peer's pinned device set, taken BEFORE the loop below.
  //
  // This ordering is required, not stylistic: encryptForDevice →
  // processPreKeyBundle pins the identity of every bundle it handshakes with.
  // Re-reading the set per iteration would see devices this very send just
  // pinned, so on first contact every device after the first would look
  // "newly added" — a guaranteed false positive.
  const knownDeviceIds =
    await keyStorage.getTrustedDeviceIdsForUser(recipientUserId);

  // Encrypt for each recipient device. Legacy devices (no signing_key)
  // are flagged in the e2eeStore so the UI can render an "incompatible
  // device" banner against this DM. We still produce envelopes for the
  // OTHER recipient devices (modern ones) so the conversation stays
  // partially functional — only the legacy device is left out, and the
  // banner explains why.
  let sawLegacyDevice = false;
  for (const bundle of recipientBundles.data) {
    // Silent device addition: a device the peer's key bundle now advertises
    // but which we have never pinned. A hostile server adding a device it
    // controls to the fan-out set is exactly the attack this surfaces.
    //
    // An empty pin set means first contact with this user (TOFU) — there is
    // no baseline to compare against, so every device is "new" and alerting
    // would be noise. Advisory only: the alert is recorded and the send
    // continues (Signal's behaviour — never strand the user's message).
    if (knownDeviceIds.size > 0 && !knownDeviceIds.has(bundle.device_id)) {
      useE2EEStore.getState().markPeerTrustAlert({
        userId: recipientUserId,
        deviceId: bundle.device_id,
        kind: "new_device",
        detectedAt: Date.now(),
      });
    }

    try {
      const envelope = await encryptForDevice(
        recipientUserId,
        bundle,
        localDeviceId,
        plaintext,
      );
      envelopes.push(envelope);
    } catch (err) {
      if (err instanceof LegacyDeviceError) {
        useE2EEStore.getState().markIncompatibleDevice(err.userId, err.deviceId);
        sawLegacyDevice = true;
        continue;
      }
      throw err;
    }
  }

  if (envelopes.length === 0 && sawLegacyDevice) {
    // ALL recipient devices are legacy — caller can't send the message at
    // all. Re-throw the most-specific error so the UI shows the right banner.
    throw new LegacyDeviceError(recipientUserId, recipientBundles.data[0].device_id);
  }

  // Self-fanout: encrypt for sender's other devices.
  //
  // Earlier code deleted the existing session before every send to force
  // a PreKey message — this guaranteed the other device could decrypt
  // even after a recovery restore wiped its ratchet state. But it cost
  // a fresh X3DH (4 DH operations) and a prekey consumption on every
  // single self-DM, which is wasteful and burns through the prekey pool.
  //
  // New strategy: only force a fresh PreKey when we suspect the receiver
  // lost its session — specifically when this is the first self-fanout
  // since our own startup, or when we explicitly know we just restored.
  // The recovery-aware flag is tracked in metadata under "self_fanout_reset".
  // After one successful re-handshake the flag clears and subsequent sends
  // re-use the Double Ratchet session.
  //
  // The flag read, the per-device delete + re-handshake, and the flag clear
  // form one read-check-act sequence, so they run under selfFanoutLock —
  // see its doc comment for what that does and does not protect. Only this
  // block is serialized; encrypting for recipient devices above stays
  // parallel-friendly.
  const selfEnvelopes = await withSelfFanoutLock(async () => {
    const produced: EncryptedEnvelope[] = [];
    const needsReset =
      (await keyStorage.getMetadata<boolean>("self_fanout_reset")) === true;
    const selfBundles = await e2eeApi.fetchPreKeyBundles(currentUserId);
    if (selfBundles.success && selfBundles.data) {
      // Snapshot of OUR OWN pinned device set, taken once BEFORE the loop.
      //
      // Same ordering invariant as the recipient snapshot above, and it bites
      // harder here: encryptForDevice → processPreKeyBundle pins each self
      // device as the loop walks it, so a per-iteration read would observe
      // this very send's writes and, on first contact, report every device
      // after the first as injected.
      const knownSelfDeviceIds =
        await keyStorage.getTrustedDeviceIdsForUser(currentUserId);

      for (const bundle of selfBundles.data) {
        // Skip own device. Must come BEFORE the call below: the local device
        // is never pinned (there is no session to self), so checking it first
        // would flag us as an injected device on every single send.
        if (bundle.device_id === localDeviceId) continue;

        const envelope = await encryptForOwnDevice(
          currentUserId,
          bundle,
          localDeviceId,
          plaintext,
          knownSelfDeviceIds,
          needsReset
        );
        produced.push(envelope);
      }
      if (needsReset) {
        // Clear the flag — we've done the expensive handshake for every
        // self-device. Subsequent sends use the established Double Ratchet
        // session, getting forward secrecy without per-message cost.
        await keyStorage.setMetadata("self_fanout_reset", false);
      }
    }
    return produced;
  });
  envelopes.push(...selfEnvelopes);

  return envelopes;
}

/**
 * Signals that the next encryptDMMessage should delete every self-device
 * session and force a fresh PreKey handshake. Call after a recovery
 * restore (so the recovered device has the new ratchet state) or any time
 * other-device session state is suspect.
 */
export async function markSelfFanoutNeedsReset(): Promise<void> {
  await keyStorage.setMetadata("self_fanout_reset", true);
}

/**
 * Thrown when a peer device's prekey bundle is missing the dedicated
 * Ed25519 signing key required by the post-C5 protocol. Caught by
 * encryptDMMessage so the calling UI can render an "incompatible device"
 * banner instead of surfacing a raw stack trace.
 *
 * userId + deviceId pinpoint exactly which peer needs to re-register;
 * the e2eeStore.incompatibleDevices Set keys off these so the banner
 * targets the right conversation.
 */
export class LegacyDeviceError extends Error {
  readonly userId: string;
  readonly deviceId: string;

  constructor(userId: string, deviceId: string) {
    super(
      `Peer device ${userId}:${deviceId} uses the legacy E2EE format ` +
        `(no Ed25519 signing key). They must update their app and re-register ` +
        `their device before encrypted messages can be exchanged.`,
    );
    this.name = "LegacyDeviceError";
    this.userId = userId;
    this.deviceId = deviceId;
  }
}

/**
 * Self-fanout body for ONE sibling device: own-account alert, optional session
 * reset, then the encryption itself. Extracted verbatim from the loop in
 * encryptDMMessage; the local-device skip stays at the call site because it
 * must run before any of this.
 *
 * knownSelfDeviceIds is a PARAMETER, never re-read here — it is the snapshot
 * the caller takes once before the loop. encryptForDevice →
 * processPreKeyBundle pins each device as the loop walks it, so reading the
 * set from inside this function would observe this very send's own writes and,
 * on first contact, report every device after the first as injected. Taking it
 * as an argument makes that ordering mistake structurally impossible.
 *
 * Runs under selfFanoutLock via its only caller; needsReset is likewise read
 * once by the caller so the read-check-act sequence stays atomic.
 */
async function encryptForOwnDevice(
  currentUserId: string,
  bundle: PreKeyBundleResponse,
  localDeviceId: string,
  plaintext: string,
  knownSelfDeviceIds: ReadonlySet<string>,
  needsReset: boolean
): Promise<EncryptedEnvelope> {
  // A device the server lists under OUR OWN account that this device has
  // never pinned. Linking a second device is a user action — but the
  // server owns this list, and every id in it gets a copy of the message
  // encrypted to it right below. An injected row therefore reads every
  // DM we send, in every conversation, which is why it is surfaced as
  // its own kind instead of the peer-facing new_device.
  //
  // An empty pin set means the first self-fanout on this install (fresh
  // setup or post-recovery restore) — no baseline exists, so it stays
  // silent, the same accepted TOFU limit as the recipient path.
  // Advisory only: the envelope is still produced and the message still
  // goes out (Signal's behaviour — never strand the user's message).
  if (
    knownSelfDeviceIds.size > 0 &&
    !knownSelfDeviceIds.has(bundle.device_id)
  ) {
    useE2EEStore.getState().markPeerTrustAlert({
      userId: currentUserId,
      deviceId: bundle.device_id,
      kind: "own_new_device",
      detectedAt: Date.now(),
    });
  }

  if (needsReset) {
    await keyStorage.deleteSession(currentUserId, bundle.device_id);
  }

  const envelope = await encryptForDevice(
    currentUserId,
    bundle,
    localDeviceId,
    plaintext
  );
  return envelope;
}

/** Encrypt for a single device. Establishes X3DH session if none exists. */
async function encryptForDevice(
  userId: string,
  bundle: PreKeyBundleResponse,
  senderDeviceId: string,
  plaintext: string
): Promise<EncryptedEnvelope> {
  // Establish session if needed (X3DH key agreement).
  //
  // A dedicated signing_key is required for prekey-signature verification.
  // Earlier code fell back to identity_key (an X25519 public key) when
  // signing_key was missing — but X25519 public keys are not valid
  // Ed25519 points, so the verification would silently fail or accept
  // anything depending on the implementation. We now refuse to start a
  // session with a bundle that doesn't carry a real signing key; the
  // remote device must re-register (signalProtocol.generateAllKeys now
  // always produces one).
  if (!(await signalProtocol.hasSessionFor(userId, bundle.device_id))) {
    if (!bundle.signing_key) {
      throw new LegacyDeviceError(userId, bundle.device_id);
    }
    await signalProtocol.processPreKeyBundle(userId, bundle.device_id, {
      identityKey: bundle.identity_key,
      signingKey: bundle.signing_key,
      signedPrekeyId: bundle.signed_prekey_id,
      signedPrekey: bundle.signed_prekey,
      signedPrekeySignature: bundle.signed_prekey_signature,
      oneTimePrekeyId: bundle.one_time_prekey_id ?? undefined,
      oneTimePrekey: bundle.one_time_prekey ?? undefined,
      registrationId: bundle.registration_id,
    });
  }

  // Encrypt with Double Ratchet
  const wireMessage = await signalProtocol.encryptMessage(
    userId,
    bundle.device_id,
    plaintext
  );

  return {
    sender_device_id: senderDeviceId,
    recipient_device_id: bundle.device_id,
    message_type: wireMessage.type,
    // Full SignalWireMessage stored as JSON (header + ciphertext + preKeyInfo)
    ciphertext: JSON.stringify(wireMessage),
  };
}

// ──────────────────────────────────
// Decryption (Receiver Side)
// ──────────────────────────────────

/**
 * Picks the envelope addressed to this device, current id first.
 *
 * A recovery restore changes the local device id, so envelopes minted before
 * the restore are addressed to a previous one. The legacy lookup costs an
 * IndexedDB read and is therefore kept behind the miss — the common case
 * matches on the first pass and never pays for it.
 */
async function findEnvelopeForThisDevice(
  envelopes: EncryptedEnvelope[],
  localDeviceId: string
): Promise<EncryptedEnvelope | undefined> {
  let myEnvelope = envelopes.find(
    (env) => env.recipient_device_id === localDeviceId
  );

  if (!myEnvelope) {
    // Check legacy device IDs (from before recovery restore)
    const legacyIds = await deviceManager.getLegacyDeviceIds();
    for (const legacyId of legacyIds) {
      myEnvelope = envelopes.find(
        (env) => env.recipient_device_id === legacyId
      );
      if (myEnvelope) break;
    }
  }

  return myEnvelope;
}

/**
 * Decrypt a received E2EE DM message.
 * Finds the envelope for this device, decrypts via Signal Protocol,
 * and parses the structured payload (content + file_keys).
 */
export async function decryptDMMessage(
  senderUserId: string,
  ciphertext: string,
  senderDeviceId: string
): Promise<E2EEPayload | null> {
  const localDeviceId = useE2EEStore.getState().localDeviceId;
  if (!localDeviceId) return null;

  // Parse envelope array
  let envelopes: EncryptedEnvelope[];
  try {
    envelopes = JSON.parse(ciphertext);
  } catch {
    console.error("[dmEncryption] Failed to parse ciphertext envelopes");
    return null;
  }

  // Find envelope for this device — try current ID first, then legacy IDs
  // (after recovery restore, old envelopes are encrypted to the old device ID)
  const myEnvelope = await findEnvelopeForThisDevice(envelopes, localDeviceId);

  if (!myEnvelope) {
    // No envelope addressed to this device — a common "can't read the other
    // side's messages" cause (device mismatch after a recovery/restore). IDs
    // only, no ciphertext/plaintext.
    logToServer("warn", "dm_decrypt_no_envelope", { senderUserId, senderDeviceId });
    return null;
  }

  // Parse wire message
  let wireMessage: SignalWireMessage;
  try {
    wireMessage = JSON.parse(myEnvelope.ciphertext);
  } catch {
    console.error("[dmEncryption] Failed to parse wire message");
    return null;
  }

  // Receive-side counterpart of the send-side new-device detection.
  //
  // Split in two on purpose: the VERDICT is computed here, the alert is only
  // RAISED after decryptMessage succeeds (see below). The comparison has to
  // happen first because decryptMessage pins the sender's identity while
  // handling a PreKey message — reading the pin set afterwards would always
  // find the sender already pinned and the alert could never fire.
  //
  // Cost shape: the single-key `get` is the hot path and short-circuits for
  // every already-known device; the full prefix scan runs only for a device we
  // have never pinned. As on the send side, an empty pin set means first
  // contact (TOFU) and must stay silent, and the alert never blocks decryption.
  //
  // Trust caveat: senderUserId is server-asserted, so the pin key inherits a
  // server-declared userId — the pin binds a key to a claimed identity.
  let senderDeviceIsUnpinned = false;
  if (!(await keyStorage.getTrustedIdentity(senderUserId, senderDeviceId))) {
    const knownDeviceIds =
      await keyStorage.getTrustedDeviceIdsForUser(senderUserId);
    if (knownDeviceIds.size > 0) {
      // Another device of OUR OWN account. Suppressed here on purpose, and
      // not because it is harmless: own-account device injection is detected
      // on the SEND path instead (kind own_new_device), which sees the
      // server's fresh self-device list on every send and sits where the real
      // damage happens — a readable copy of our outgoing message. Raising a
      // second, peer-shaped alert on the echo would only double-count the same
      // event. This path has no currentUserId in its signature, so the local
      // registration supplies the distinction. Kept inside the already-cold
      // branch — the hot path (known device) has returned above without
      // paying for this read.
      //
      // Direction matters: when the registration cannot be read, `reg?.userId`
      // is undefined, which never equals senderUserId, so the alert IS raised.
      // Failing loud on unknown local state is the safe direction; inverting
      // this condition would silence a genuine warning whenever registration
      // is unavailable.
      const reg = await keyStorage.getRegistrationData();
      senderDeviceIsUnpinned = reg?.userId !== senderUserId;
    }
  }

  // Decrypt via Signal Protocol
  try {
    const plaintext = await signalProtocol.decryptMessage(
      senderUserId,
      senderDeviceId,
      wireMessage
    );

    if (plaintext === null) return null;

    // Alert only for a device that has just proved it holds a working session.
    //
    // Raising it before decryption would let a hostile server mint unlimited
    // permanent warnings: envelopes addressed to us carrying junk ciphertext
    // and an arbitrary sender_device_id never decrypt, so they never pin, so
    // the safety-number panel — which lists pinned identities — renders no row
    // to dismiss them with. A replayed PreKey message is harmless here: the
    // pin already exists by then, so the branch above never armed the flag a
    // second time.
    if (senderDeviceIsUnpinned) {
      useE2EEStore.getState().markPeerTrustAlert({
        userId: senderUserId,
        deviceId: senderDeviceId,
        kind: "new_device",
        detectedAt: Date.now(),
      });
    }

    // Parse structured payload (content + file_keys)
    return decodePayload(plaintext);
  } catch (err) {
    console.error("[dmEncryption] decrypt failed:", err);
    logToServer("warn", "dm_decrypt_failed", {
      senderUserId,
      senderDeviceId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/**
 * Batch-decrypt E2EE DM messages from fetchMessages/fetchOlderMessages.
 * Plaintext messages (encryption_version=0) pass through unchanged.
 * Successfully decrypted messages are cached to IndexedDB for client-side search.
 */
export async function decryptDMMessages(
  messages: DMMessage[]
): Promise<DMMessage[]> {
  const result: DMMessage[] = [];
  const toCache: import("./types").CachedDecryptedMessage[] = [];

  for (const msg of messages) {
    if (
      msg.encryption_version === 1 &&
      msg.ciphertext &&
      msg.sender_device_id
    ) {
      // Check IndexedDB cache first — re-decrypting breaks Double Ratchet state
      try {
        const cached = await keyStorage.getCachedDecryptedMessage(msg.id);
        if (cached) {
          result.push({ ...msg, content: cached.content });
          continue;
        }
      } catch {
        // Cache read error — fall through to decrypt
      }

      // Decrypt via Signal Protocol
      try {
        const payload = await decryptDMMessage(
          msg.user_id,
          msg.ciphertext,
          msg.sender_device_id
        );

        if (payload) {
          result.push({
            ...msg,
            content: payload.content,
            e2ee_file_keys: payload.file_keys,
          });

          if (payload.content) {
            toCache.push({
              messageId: msg.id,
              channelId: "",
              dmChannelId: msg.dm_channel_id,
              content: payload.content,
              timestamp: new Date(msg.created_at).getTime(),
            });
          }
        } else {
          // No envelope found for this device
          result.push({ ...msg, content: null });
        }
      } catch (err) {
        console.error(
          `[dmEncryption] Failed to decrypt msg ${msg.id}:`,
          err
        );
        useE2EEStore.getState().addDecryptionError({
          messageId: msg.id,
          channelId: msg.dm_channel_id,
          error: err instanceof Error ? err.message : "Decryption failed",
          timestamp: Date.now(),
        });
        result.push({ ...msg, content: null });
      }
    } else {
      // Plaintext message — pass through
      result.push(msg);
    }
  }

  // Batch cache write for performance
  if (toCache.length > 0) {
    keyStorage.cacheDecryptedMessages(toCache).catch((err) => {
      console.error("[dmEncryption] Failed to cache messages:", err);
    });
  }

  return result;
}
