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
import { cacheGroupMessage,groupMessageCacheTag,restoreGroupSourceSequence } from "./groupMessageCache";
import { groupAttachmentKey } from "../utils/groupAttachmentKeys";
import * as deviceManager from "./deviceManager";
import { decodePayload, type E2EEPayload } from "./e2eePayload";
import { useE2EEStore } from "../stores/e2eeStore";
import {useComposerDraftStore} from "../stores/composerDraftStore";
import {cacheDMMessage,readDMMessageCache} from "./dmMessageCache";
import type { EncryptedEnvelope, PreKeyBundleResponse, DMMessage, GroupDMMessage } from "../types";
import type { SignalWireMessage } from "./types";

// ──────────────────────────────────
// Sent Message Plaintext Cache
// ──────────────────────────────────

/**
 * Source-bound plaintext cache for sent DM messages.
 *
 * Signal Protocol cannot create an envelope for the sender's own device
 * (no Double Ratchet session to self). So on WS echo, the sender cannot
 * decrypt its own message.
 *
 * Solution (Signal Desktop / WhatsApp model):
 * Plaintext is pushed with its ciphertext/metadata BEFORE the API call.
 * On WS echo, the matching entry is removed. After API response, it's
 * persisted to IndexedDB for historical message access.
 *
 * Two-phase cache:
 * 1. preSendQueue: channelId → source/payload entries — pushed before API call
 * 2. IndexedDB messageCache: messageId → content — persisted after API response
 *
 * The queue is populated before POST so an early WS echo can find it.
 * Runtime echo matching never falls back to a different queued entry.
 * This identifies a local send; it is not server-side sender authentication.
 */
type SentPlaintextSource={ciphertext:string;metadata?:string|null};
type SentPlaintextEntry={payload:E2EEPayload;source?:string};
const preSendQueue = new Map<string, SentPlaintextEntry[]>();
const sentSource=(source:SentPlaintextSource)=>JSON.stringify([source.ciphertext,source.metadata??null]);

/**
 * Local device id the queued entries were pushed under. The WS handler only
 * pops for echoes whose sender_device_id is the CURRENT local device, so an
 * entry pushed before a recovery restore (which changes the id) would never
 * match its own echo and would instead be popped onto a later send's echo.
 * Every access drops the queue if the device or composer/session generation
 * has moved on, including same-device logout/relogin.
 */
let preSendQueueDeviceId: string | null = null;
let preSendQueueGeneration=-1;

function syncPreSendQueueDevice(): void {
  const current = useE2EEStore.getState().localDeviceId;
  const generation=useComposerDraftStore.getState().generation;
  if (current !== preSendQueueDeviceId || generation!==preSendQueueGeneration) {
    preSendQueue.clear();
    editCache.clear();
    preSendQueueDeviceId = current;
    preSendQueueGeneration=generation;
  }
}

/** In-memory cache for edit operations. messageId is known, so a direct Map suffices. */
const editCache = new Map<string, SentPlaintextEntry[]>();

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
export function pushSentPlaintext(dmChannelId: string, payload: E2EEPayload, source?:SentPlaintextSource): void {
  syncPreSendQueueDevice();
  const entry={payload,source:source?sentSource(source):undefined};
  const queue = preSendQueue.get(dmChannelId);
  if (queue) {
    queue.push(entry);
  } else {
    preSendQueue.set(dmChannelId, [entry]);
  }
}

/** Runtime callers supply a source; no match/ambiguous match consumes nothing.
 * Source-less compatibility calls can consume only source-less legacy entries. */
export function popSentPlaintext(dmChannelId: string,source?:SentPlaintextSource): E2EEPayload | null {
  syncPreSendQueueDevice();
  const queue = preSendQueue.get(dmChannelId);
  if (!queue || queue.length === 0) return null;

  const key=source?sentSource(source):undefined;
  const matches=queue.map((entry,index)=>entry.source===key?index:-1).filter(index=>index>=0);
  if(!matches.length||(source&&matches.length!==1))return null;
  const payload = queue.splice(matches[0],1)[0].payload;
  if (queue.length === 0) preSendQueue.delete(dmChannelId);
  return payload;
}

/** Remove last queued entry on send failure (LIFO — failed send's push is last). */
export function discardLastSentPlaintext(dmChannelId: string): void {
  syncPreSendQueueDevice();
  const queue = preSendQueue.get(dmChannelId);
  if (!queue || queue.length === 0) return;

  queue.pop();
  if (queue.length === 0) preSendQueue.delete(dmChannelId);
}

/** Remove this send's exact entry, never another concurrent send's payload. */
export function discardSentPlaintext(dmChannelId:string,payload:E2EEPayload):void{
  syncPreSendQueueDevice();const queue=preSendQueue.get(dmChannelId);if(!queue)return;
  const index=queue.findIndex(entry=>entry.payload===payload);if(index<0)return;queue.splice(index,1);if(!queue.length)preSendQueue.delete(dmChannelId);
}

/** Cache plaintext before edit API call. */
export function cacheEditPlaintext(messageId: string, payload: E2EEPayload,source?:SentPlaintextSource): void {
  syncPreSendQueueDevice();const entries=editCache.get(messageId)??[];entries.push({payload,source:source?sentSource(source):undefined});editCache.set(messageId,entries);
}

/** Pop plaintext from edit cache. */
export function popEditPlaintext(messageId: string,source?:SentPlaintextSource): E2EEPayload | null {
  syncPreSendQueueDevice();const entries=editCache.get(messageId);if(!entries)return null;
  const key=source?sentSource(source):undefined,matches=entries.map((entry,index)=>entry.source===key?index:-1).filter(index=>index>=0);
  if(!matches.length||(source&&matches.length!==1))return null;
  const payload=entries.splice(matches[0],1)[0].payload;if(!entries.length)editCache.delete(messageId);return payload;
}
export function discardEditPlaintext(messageId:string,payload:E2EEPayload):void{
  syncPreSendQueueDevice();const entries=editCache.get(messageId);if(!entries)return;const index=entries.findIndex(entry=>entry.payload===payload);if(index>=0)entries.splice(index,1);if(!entries.length)editCache.delete(messageId);
}

/** Persist plaintext to IndexedDB after API response for historical access. */
export async function persistSentPlaintext(
  messageId: string,
  dmChannelId: string,
  content: string,
  isCurrent:()=>boolean=()=>true
): Promise<void> {
  await keyStorage.cacheDecryptedMessage({
    messageId,
    channelId: "",
    dmChannelId,
    content,
    timestamp: Date.now(),
  },isCurrent);
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

  // Self-DM ("My Notes": a DM channel whose other_user is the sender). The
  // recipient's devices ARE our own devices, which the self-fanout block below
  // already covers — so the recipient pass is skipped entirely. Running it
  // would (a) open a Signal session with the LOCAL device, i.e. with ourselves,
  // and pin our own identity under it, and (b) encrypt a second copy for every
  // sibling device, advancing each sibling ratchet twice per message.
  //
  // RECIPIENT_NO_KEYS is skipped with it on purpose: that error triggers the
  // caller's PLAINTEXT fallback, and a single-device user must still be able
  // to write encrypted notes. That user ends up with zero envelopes, which is
  // correct — the local device never reads its own sends from ciphertext; it
  // renders them from the sent-plaintext cache (pushSentPlaintext →
  // popSentPlaintext on the WS echo, persistSentPlaintext for history).
  if (recipientUserId !== currentUserId) {
    envelopes.push(
      ...(await encryptForRecipientDevices(
        recipientUserId,
        localDeviceId,
        plaintext
      ))
    );
  }

  envelopes.push(
    ...(await encryptForSelfFanout(
      currentUserId,
      localDeviceId,
      plaintext,
      recipientUserId === currentUserId
    ))
  );

  return envelopes;
}

/** Encrypt one group-DM payload for every current member device and for the
 * sender's other devices. Member IDs must come from the server's current
 * group snapshot; the group key epoch on the send request prevents a stale
 * membership snapshot from being accepted after a rekey. */
export async function encryptGroupDMMessage(
  currentUserId: string,
  memberUserIds: readonly string[],
  localDeviceId: string,
  plaintext: string
): Promise<EncryptedEnvelope[]> {
  const envelopes: EncryptedEnvelope[] = [];
  const recipients = [...new Set(memberUserIds)].filter((id) => id !== currentUserId);
  for (const recipientUserId of recipients) {
    envelopes.push(...await encryptForRecipientDevices(recipientUserId, localDeviceId, plaintext));
  }
  envelopes.push(...await encryptForSelfFanout(currentUserId, localDeviceId, plaintext, true));
  return envelopes;
}

/**
 * Recipient pass of encryptDMMessage: one envelope per device of a PEER
 * account. Never called with the sender's own userId (see the self-DM note
 * in encryptDMMessage). Extracted verbatim; behaviour for peer DMs unchanged.
 */
async function encryptForRecipientDevices(
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

  return envelopes;
}

/**
 * Self-fanout pass of encryptDMMessage: one envelope per OTHER device of the
 * sender's own account (the local device is always skipped). For a self-DM
 * this is the only pass that runs.
 *
 * selfFanoutRequired: set for a self-DM. A failed own-bundle fetch is then
 * fatal (SELF_FANOUT_UNAVAILABLE) instead of silently yielding no envelopes —
 * with no recipient pass, "[]" would make the note permanently unreadable on
 * every sibling device. Deliberately NOT RECIPIENT_NO_KEYS, which would make
 * the caller resend as plaintext. Peer DMs keep the lenient behaviour.
 */
async function encryptForSelfFanout(
  currentUserId: string,
  localDeviceId: string,
  plaintext: string,
  selfFanoutRequired: boolean
): Promise<EncryptedEnvelope[]> {
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
  // block is serialized; encrypting for recipient devices
  // (encryptForRecipientDevices) stays parallel-friendly.
  return withSelfFanoutLock(async () => {
    const produced: EncryptedEnvelope[] = [];
    const needsReset =
      (await keyStorage.getMetadata<boolean>("self_fanout_reset")) === true;
    const selfBundles = await e2eeApi.fetchPreKeyBundles(currentUserId);
    if (selfFanoutRequired && !(selfBundles.success && selfBundles.data)) {
      // Reset flag untouched: no handshake happened, the next send retries it.
      throw new Error("SELF_FANOUT_UNAVAILABLE");
    }
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

  // A message sent FROM this very device never carries an envelope this
  // device can open: the send path never encrypts to the local device (no
  // session to self — that copy lives in the sent-plaintext cache). So an
  // envelope claiming sender == local device is either a cache miss on our
  // own send (benign, nothing to decrypt) or server-forged; either way,
  // handing it to decryptMessage could only establish a session with
  // ourselves and pin a server-chosen identity under our own device id.
  // Matters most for the self-DM, where sender and recipient are both us.
  if (senderDeviceId === localDeviceId) return null;

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
  messages: DMMessage[],isCurrent:()=>boolean=()=>true,isMessageCurrent:(message:DMMessage)=>boolean=()=>true
): Promise<DMMessage[]> {
  const result: DMMessage[] = [];
  const generation=useComposerDraftStore.getState().generation,device=useE2EEStore.getState().localDeviceId;
  const contextCurrent=()=>isCurrent()&&useComposerDraftStore.getState().generation===generation&&useE2EEStore.getState().localDeviceId===device;

  for (const msg of messages) {
    if(!contextCurrent())return [];
    const current=()=>contextCurrent()&&isMessageCurrent(msg);
    if(!current())continue;
    if (
      msg.encryption_version === 1 &&
      msg.ciphertext &&
      msg.sender_device_id
    ) {
      // Check IndexedDB cache first — re-decrypting breaks Double Ratchet state
      try {
        const cached = await readDMMessageCache(msg,current);
        if(!contextCurrent())return [];
        if(!current())continue;
        if (cached) {
          result.push({ ...msg, content: cached.content,e2ee_file_keys:cached.file_keys });
          continue;
        }
      } catch {
        // Cache read error — fall through to decrypt
      }
      if(!contextCurrent())return [];
      if(!current())continue;

      // Decrypt via Signal Protocol
      try {
        const payload = await decryptDMMessage(
          msg.user_id,
          msg.ciphertext,
          msg.sender_device_id
        );
        if(!contextCurrent())return [];
        if(!current())continue;

        if (payload) {
          result.push({
            ...msg,
            content: payload.content,
            e2ee_file_keys: payload.file_keys,
          });

          try{await cacheDMMessage(msg,payload,current)}catch{console.warn("[dmEncryption] version cache write failed")}
        } else {
          // No envelope found for this device
          result.push({ ...msg, content: null,e2ee_file_keys:undefined });
        }
      } catch (err) {
        if(!contextCurrent())return [];
        if(!current())continue;
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
        result.push({ ...msg, content: null,e2ee_file_keys:undefined });
      }
    } else {
      // Plaintext message — pass through
      result.push(msg);
    }
  }

  return result.filter(isMessageCurrent);
}

/** Batch decryptor for group DMs. It shares the same Signal envelopes and
 * local plaintext cache as 1:1 DMs, while keeping the group id as a separate
 * cache namespace. */
export async function decryptGroupDMMessages(messages: GroupDMMessage[],isCurrent:()=>boolean=()=>true,isMessageCurrent:(message:GroupDMMessage)=>boolean=()=>true): Promise<GroupDMMessage[]> {
  const result: GroupDMMessage[] = [];
  for (const msg of messages) {
    if(!isCurrent())return [];
    if(!isMessageCurrent(msg))continue;
    const active=()=>isCurrent()&&isMessageCurrent(msg);
    if (!msg.ciphertext || !msg.sender_device_id) {
      result.push({ ...msg, content: null,e2ee_file_keys:undefined });
      continue;
    }
    const cached = await keyStorage.getCachedDecryptedMessage(msg.id).catch(() => null);
    if(!isCurrent())return [];
    if(!isMessageCurrent(msg))continue;
    try {
      const tag=await groupMessageCacheTag(msg);
      if(!isCurrent())return [];
      if(!isMessageCurrent(msg))continue;
      const sameScope=cached?.dmChannelId===`group:${msg.group_id}` && cached.channelId==="";
      const hasFileKeys=!msg.attachments?.length || msg.attachments.every((attachment,index)=>Boolean(groupAttachmentKey(cached?.fileKeys,attachment,index)));
      const legacyOriginal=sameScope && !cached.encryptedSourceTag && !msg.edited_at && !msg.attachments?.length;
      if(cached && sameScope && hasFileKeys && (cached.encryptedSourceTag===tag || legacyOriginal)){
        const restored=restoreGroupSourceSequence(msg,cached.sourceSequence);
        if(legacyOriginal) {
          // Preserve pre-versioning original plaintext without replaying a
          // consumed Signal message. Edited legacy entries stay untouched
          // unless the current encrypted version can actually be opened.
          try{await cacheGroupMessage(restored,{content:cached.content},active,tag)}catch{ /* An upgrade failure must not hide the available original. */ }
          if(!isCurrent())return [];
          if(!isMessageCurrent(msg))continue;
        }
        result.push({...restored,content:cached.content,e2ee_file_keys:cached.fileKeys,decryption_error:undefined});
        continue;
      }
      const payload = await decryptDMMessage(msg.user_id, msg.ciphertext, msg.sender_device_id);
      if(!isCurrent())return [];
      if(!isMessageCurrent(msg))continue;
      result.push({ ...msg, content: payload?.content ?? null, e2ee_file_keys: payload?.file_keys,decryption_error:!payload&&cached?"version_unavailable":undefined });
      if (payload) {
        // A cache failure does not invalidate successfully decrypted content.
        try{await cacheGroupMessage(msg,payload,active,tag)}catch{console.warn("[groupDM] decrypted version cache write failed")}
      }
    } catch {
      if(!isCurrent())return [];
      if(!isMessageCurrent(msg))continue;
      result.push({ ...msg, content: null,e2ee_file_keys:undefined,decryption_error:cached?"version_unavailable":undefined });
    }
  }
  return isCurrent()?result.filter(isMessageCurrent):[];
}
