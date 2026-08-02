/**
 * Channel Encryption — E2EE encrypt/decrypt layer for channel/group messages.
 *
 * This module is called by messageStore (sending) and useWebSocket (receiving).
 * Using Sender Key Protocol primitives:
 * - Send: plaintext → SenderKeyMessage (single ciphertext, all members share)
 * - Receive: SenderKeyMessage → plaintext
 *
 * Sender Key vs Signal (DM):
 * - In DM, separate encryption is performed for each recipient device (N ciphertexts)
 * - In a channel, a single encryption is performed and all members decrypt the same ciphertext
 * - Performance benefit: in a 100-member channel, 1 encrypt vs 100 encrypts
 *
 * Sender Key distribution:
 * The sender mints a new Sender Key on the first message (or on rotation) and
 * seals it once per recipient DEVICE inside that device's Signal session, then
 * uploads the whole envelope set in one request. Members fetch the envelope
 * addressed to them, decrypt it with their Signal session, and install the
 * result as an inbound sender key.
 *
 * Key rotation:
 * - Automatic rotation every 100 messages
 * - Automatic rotation every 7 days
 * - Rotation when the recipient roster changes (fingerprint mismatch)
 * - Rotation when the stored outbound key predates the v2 distribution format
 */

import * as senderKeyProtocol from "./senderKeyProtocol.js";
import * as signalProtocol from "./signalProtocol.js";
import * as e2eeApi from "../api/e2ee.js";
import * as keyStorage from "./keyStorage.js";
import { fromBase64 } from "./signalProtocol.js";
import { LegacyDeviceError } from "./dmEncryption.js";
import { decodePayload, type E2EEPayload } from "./e2eePayload.js";
import { useE2EEStore } from "../stores/e2eeStore.js";
import { useServerStore } from "../stores/serverStore.js";
import { useMemberStore } from "../stores/memberStore.js";
import { useChannelPermissionStore } from "../stores/channelPermissionStore.js";
import {
  Permissions,
  hasPermission,
  resolveChannelPermissions,
} from "../utils/permissions.js";
import {
  SENDER_KEY_PROTOCOL_VERSION,
  type SenderKeyMessage,
  type SenderKeyDistributionData,
  type SenderKeyEnvelopeUpload,
  type SignalWireMessage,
} from "./types.js";
import type { Message, SenderKeyRecipient } from "../types/index.js";

// ──────────────────────────────────
// Recipient-roster staleness tracking
// ──────────────────────────────────

/**
 * Channels whose recipient roster is suspected to have moved since the
 * outbound sender key was sealed.
 *
 * A v2 distribution only reaches the devices that got an envelope, so a new
 * member (or a new device on an existing member) cannot read the channel until
 * we mint and re-seal. The WS/UI layer arms these marks on membership and
 * device events; the next send in that channel re-reads the roster ONCE and
 * only pays for a rotation if the fingerprint genuinely differs. Marking is
 * therefore cheap and safe to over-signal.
 */
const staleRecipients = new Set<string>();

/**
 * Monotonic epoch bumped by markAllChannelRecipientsStale.
 *
 * A channel whose last roster check predates the current epoch must re-check
 * once. An epoch counter rather than a sticky boolean is what keeps
 * "everything is stale" costing one roster read per channel instead of one per
 * message forever.
 *
 * A channel with no entry counts as never-checked, so the first send after a
 * page load verifies the roster once — membership can change while we are
 * offline, and the stored fingerprint alone cannot tell us.
 */
let staleEpoch = 0;
const checkedEpoch = new Map<string, number>();

/** Arm a roster re-check for one channel (member/device event). */
export function markChannelRecipientsStale(channelId: string): void {
  staleRecipients.add(channelId);
}

/** Arm a roster re-check for every channel (e.g. reconnect / bulk resync). */
export function markAllChannelRecipientsStale(): void {
  staleEpoch++;
  // Per-channel marks are subsumed by the epoch bump.
  staleRecipients.clear();
}

function recipientsNeedRecheck(channelId: string): boolean {
  if (staleRecipients.has(channelId)) return true;
  return (checkedEpoch.get(channelId) ?? -1) < staleEpoch;
}

function markRecipientsChecked(channelId: string): void {
  staleRecipients.delete(channelId);
  checkedEpoch.set(channelId, staleEpoch);
}

// ──────────────────────────────────
// Per-channel distribution lock
// ──────────────────────────────────

/**
 * Serializes the "decide whether to rotate → mint → seal → upload" sequence
 * per channel.
 *
 * That sequence is a read-check-act over shared state (the stored outbound key
 * plus the staleness marks) with several awaits inside it. Two overlapping
 * sends in the same channel would both observe "needs rotation", both mint a
 * distribution, and the second would overwrite the first's outbound key — so
 * the first send's ciphertext would be encrypted under a key its own upload no
 * longer matches, and one one-time prekey per recipient would be burned twice.
 *
 * Deliberately NOT covered:
 * - The encryptGroupMessage ratchet itself. Concurrent sends can still read
 *   the same chain position and emit two messages at the same iteration; the
 *   receiver's replay window then rejects one. Pre-existing, and closing it
 *   means serializing every send in the channel.
 * - Cross-tab races. This lock is per-JS-context; the sender key lives in
 *   IndexedDB shared by every tab. Closing that needs the Web Locks API.
 */
const distributionLocks = new Map<string, Promise<unknown>>();

function withDistributionLock<T>(
  channelId: string,
  fn: () => Promise<T>
): Promise<T> {
  const previous = distributionLocks.get(channelId) ?? Promise.resolve();
  // Chain on the swallowed form: one failed send must not poison the queue.
  const run = previous.catch(() => {}).then(fn);
  const settled = run.then(
    () => {},
    () => {}
  );
  distributionLocks.set(channelId, settled);
  // Drop the entry once this is the tail, so the map does not grow with every
  // channel the user has ever sent to.
  void settled.then(() => {
    if (distributionLocks.get(channelId) === settled) {
      distributionLocks.delete(channelId);
    }
  });
  return run;
}

// ──────────────────────────────────
// Encryption (Sender Side)
// ──────────────────────────────────

/**
 * Encrypts a channel message with the Sender Key.
 *
 * Flow:
 * 1. Check whether an outbound sender key exists for this channel
 * 2. If missing / rotation is due / the roster moved → mint a new
 *    distribution, seal it per recipient device, upload
 * 3. Encrypt with encryptGroupMessage
 * 4. Returns a SenderKeyMessage — JSON.stringify is written into the ciphertext field
 *
 * @param channelId - Channel ID
 * @param userId - Sender user ID
 * @param deviceId - This device's ID
 * @param plaintext - Unencrypted message text
 */
export async function encryptChannelMessage(
  channelId: string,
  userId: string,
  deviceId: string,
  plaintext: string
): Promise<SenderKeyMessage> {
  await withDistributionLock(channelId, () =>
    ensureDistribution(channelId, userId, deviceId)
  );

  // Encrypt with Sender Key — single ciphertext, all members decrypt
  return senderKeyProtocol.encryptGroupMessage(
    channelId,
    userId,
    deviceId,
    plaintext
  );
}

/**
 * Guarantees a usable outbound distribution before the message is encrypted.
 * Runs under withDistributionLock — see that comment for the interleaving it
 * protects against.
 */
async function ensureDistribution(
  channelId: string,
  userId: string,
  deviceId: string
): Promise<void> {
  // Age / message-count / protocol-version rotation. Version enforcement is
  // outbound-only and lives in needsSenderKeyRotation by design.
  let rotate = await senderKeyProtocol.needsSenderKeyRotation(
    channelId,
    userId,
    deviceId
  );

  // Roster check. Only worth doing when nothing else already forces a
  // rotation, since a rotation re-reads the roster anyway.
  let roster: LoadedRoster | null = null;
  if (!rotate && recipientsNeedRecheck(channelId)) {
    const serverId = useServerStore.getState().activeServerId;
    if (serverId) {
      roster = await loadRoster(serverId, channelId, userId, deviceId);
      const existing = await keyStorage.getSenderKey(
        channelId,
        userId,
        deviceId
      );
      // A fingerprint mismatch means some device on the current roster holds
      // no envelope for this key. An exact match means the roster only
      // *looked* like it changed — keep ratcheting, no rotation cost.
      rotate = !existing || existing.recipientFingerprint !== roster.fingerprint;
      markRecipientsChecked(channelId);
    }
  }

  if (rotate) {
    const distributed = await createAndUploadDistribution(
      channelId,
      userId,
      deviceId,
      roster
    );
    if (distributed) {
      markRecipientsChecked(channelId);
    } else {
      // Nothing was uploaded because the roster held no other device. Stay
      // armed so the next send re-reads it — that is what makes a transient
      // empty roster self-heal instead of silently leaving real members
      // without the key for the rest of this distribution's life.
      markChannelRecipientsStale(channelId);
    }
  }
}

type LoadedRoster = {
  /**
   * Devices that must receive an envelope: the server's list MINUS our own
   * calling device. We are never a recipient of our own distribution — there
   * is no Signal session to self — so the server is expected to omit us and
   * this filter is defence in depth.
   */
  recipients: SenderKeyRecipient[];
  /**
   * Fingerprint over the RAW server list, before the self-filter. Stored
   * outbound keys were fingerprinted the same way; narrowing the input set
   * here would make every existing key look stale and force a needless
   * one-off rotation for every user.
   */
  fingerprint: string;
};

/**
 * Thrown when the server answers "nobody" for a channel the client's own
 * member list says other people can read.
 *
 * The roster is entirely the SERVER's claim. Treating an empty one as a solo
 * channel — mint a key, upload no envelope, send anyway — hands the server a
 * silent, targeted censorship primitive: the sender decrypts their own message
 * through their own outbound key and sees nothing wrong, while every real
 * member of the channel gets ciphertext they hold no key for. A visible send
 * failure is the honest outcome; being quietly unheard is not.
 *
 * channelId + expectedReaders let the UI say which channel and how many
 * members the client believed could read it.
 */
export class SuppressedRosterError extends Error {
  readonly channelId: string;
  readonly expectedReaders: number;

  constructor(channelId: string, expectedReaders: number) {
    super(
      `Sender-key roster for channel ${channelId} came back empty while the ` +
        `member list says ${expectedReaders} other member(s) can read it. ` +
        `Refusing to send a message no recipient could decrypt.`
    );
    this.name = "SuppressedRosterError";
    this.channelId = channelId;
    this.expectedReaders = expectedReaders;
  }
}

/**
 * How many members OTHER than us the client believes can read this channel.
 *
 * Returns null when the client genuinely cannot tell, and "cannot tell" must
 * never collapse into "zero": a wrong zero silently re-opens the censorship
 * hole, but a wrong non-zero makes a legitimate channel permanently
 * unsendable. Both unknowns below therefore fail towards the historical
 * behaviour:
 *   - the member list for this server has not landed (cold start, mid-switch)
 *     or is being refetched;
 *   - the channel's permission overrides were never fetched. Without them a
 *     locked-down channel looks world-readable, and a channel only the sender
 *     may read has a legitimately empty roster.
 *
 * The permission arithmetic mirrors the server's PermCanReadChannel two-bit
 * gate (models/role.go) — the same gate GetSenderKeyRecipients filters the
 * roster with, which is what makes the two numbers comparable at all.
 */
function countOtherChannelReaders(
  serverId: string,
  channelId: string,
  selfUserId: string
): number | null {
  const memberState = useMemberStore.getState();
  if (memberState.loadingServers.has(serverId)) return null;
  const members = memberState.membersByServer[serverId];
  if (members === undefined) return null;

  const permState = useChannelPermissionStore.getState();
  if (!permState.fetchedChannels.has(channelId)) return null;
  const overrides = permState.getOverrides(channelId);

  let readers = 0;
  for (const member of members) {
    if (member.id === selfUserId) continue;
    const perms = resolveChannelPermissions(
      member.effective_permissions,
      member.roles.map((r) => r.id),
      overrides
    );
    if (
      hasPermission(perms, Permissions.ViewChannel) &&
      hasPermission(perms, Permissions.ReadMessages)
    ) {
      readers++;
    }
  }
  return readers;
}

/**
 * Cross-checks an empty recipient roster against the member list before the
 * caller is allowed to read it as "solo channel". See SuppressedRosterError.
 */
function assertEmptyRosterIsPlausible(
  serverId: string,
  channelId: string,
  userId: string
): void {
  const readers = countOtherChannelReaders(serverId, channelId, userId);
  if (readers !== null && readers > 0) {
    throw new SuppressedRosterError(channelId, readers);
  }
}

/**
 * Fetch the channel's recipient roster, fingerprint it, and refuse an empty
 * one that the member list contradicts.
 *
 * The guard lives here rather than at the single "no candidates" branch below
 * because this is the one funnel every send path uses to learn who the
 * recipients are — including the roster re-check that can decide NOT to
 * rotate, which never reaches that branch. It is applied to the self-filtered
 * list on purpose: a roster containing only our own calling device produces
 * exactly the same "no envelopes uploaded" outcome as an empty one.
 */
async function loadRoster(
  serverId: string,
  channelId: string,
  userId: string,
  deviceId: string
): Promise<LoadedRoster> {
  const res = await e2eeApi.fetchSenderKeyRecipients(
    serverId,
    channelId,
    deviceId
  );
  if (!res.success || !res.data) {
    throw new Error(
      `Failed to fetch sender-key recipients for channel ${channelId}`
    );
  }
  const fingerprint = await senderKeyProtocol.computeRecipientFingerprint(
    res.data.map((r) => ({ userId: r.user_id, deviceId: r.device_id }))
  );
  const recipients = res.data.filter((r) => r.device_id !== deviceId);
  if (recipients.length === 0) {
    assertEmptyRosterIsPlausible(serverId, channelId, userId);
  }
  return { recipients, fingerprint };
}

/**
 * Mints a new Sender Key distribution and uploads it SEALED — one envelope per
 * recipient device (pentest C-03).
 *
 * The distribution carries `chainKey`, the 32-byte symmetric group key. It is
 * therefore never handed to the server as readable JSON: it is serialized once
 * and then encrypted separately into every recipient device's Signal session
 * (the same Double Ratchet that protects DMs), exactly the way dmEncryption
 * fans a DM out. The server stores and routes N opaque envelopes and can
 * decrypt none of them, so channel E2EE now protects messages from the server
 * operator as well as from non-member users.
 *
 * Ordering matters: the roster fetch and every X3DH handshake run BEFORE the
 * key is minted, so the failure-prone remote work cannot leave a freshly
 * minted key stranded. The only step that can still fail after minting is the
 * upload itself, and that path deliberately blanks the key's roster
 * fingerprint so the next send re-mints instead of encrypting under a
 * distribution nobody received.
 *
 * @returns true if a distribution was uploaded; false if there was simply
 *          nobody to distribute to (see the empty-roster branch).
 */
async function createAndUploadDistribution(
  channelId: string,
  userId: string,
  deviceId: string,
  prefetched: LoadedRoster | null
): Promise<boolean> {
  const serverId = useServerStore.getState().activeServerId;
  if (!serverId) throw new Error("No active server");

  const roster =
    prefetched ?? (await loadRoster(serverId, channelId, userId, deviceId));

  // Already self-filtered by loadRoster, which is also where the empty case is
  // cross-checked against the member list.
  const candidates = roster.recipients;

  if (candidates.length === 0) {
    // A channel where we are the only member on the only device — and
    // loadRoster has confirmed the client's own member list agrees, so this is
    // solitude rather than a suppressed roster. Mint the key so we can encrypt
    // (and read our own history back through the outbound key), but make NO
    // request — an empty envelope set is not a distribution, and this must not
    // read as an error the way "everyone is legacy" does.
    await senderKeyProtocol.createDistribution(
      channelId,
      userId,
      deviceId,
      roster.fingerprint
    );
    return false;
  }

  // Phase 1 — establish a Signal session with every recipient device.
  //
  // Error tolerance mirrors dmEncryption's fanout exactly: a device still
  // registered under the legacy format (no Ed25519 signing key) is flagged in
  // the e2eeStore so the UI can explain itself, and we keep going for the
  // OTHER devices. One outdated device must not lock the whole channel.
  const sealable: SenderKeyRecipient[] = [];
  for (const recipient of candidates) {
    try {
      await ensureSessionForRecipient(recipient);
      sealable.push(recipient);
    } catch (err) {
      if (err instanceof LegacyDeviceError) {
        useE2EEStore.getState().markIncompatibleDevice(err.userId, err.deviceId);
        continue;
      }
      throw err;
    }
  }

  if (sealable.length === 0) {
    // We had candidates and none survived, so every one of them took the
    // LegacyDeviceError branch above (anything else would have propagated).
    // Mirrors dmEncryption re-throwing the most-specific error so the UI can
    // show the right banner instead of a raw stack trace.
    throw new Error(
      `Every recipient device in channel ${channelId} uses the legacy E2EE ` +
        `format (no Ed25519 signing key); the sender key cannot be distributed.`
    );
  }

  // Phase 2 — mint, seal, upload.
  const distribution = await senderKeyProtocol.createDistribution(
    channelId,
    userId,
    deviceId,
    roster.fingerprint
  );

  try {
    // The version travels INSIDE the sealed plaintext as well as on the
    // envelope wrapper: the wrapper is server-visible metadata, the inner copy
    // is what a recipient can actually trust.
    // Written field-by-field rather than spread: this literal IS the wire
    // contract, so every field that leaves the device is visible here.
    const sealedPlaintext = JSON.stringify({
      version: SENDER_KEY_PROTOCOL_VERSION,
      distributionId: distribution.distributionId,
      chainKey: distribution.chainKey,
      publicSigningKey: distribution.publicSigningKey,
      iteration: distribution.iteration,
    } satisfies SenderKeyDistributionData);

    const envelopes: SenderKeyEnvelopeUpload[] = [];
    for (const recipient of sealable) {
      const wireMessage = await signalProtocol.encryptMessage(
        recipient.user_id,
        recipient.device_id,
        sealedPlaintext
      );
      envelopes.push({
        recipient_user_id: recipient.user_id,
        recipient_device_id: recipient.device_id,
        message_type: wireMessage.type,
        ciphertext: JSON.stringify(wireMessage),
      });
    }

    // Single request: the server must accept the whole envelope set or none.
    await e2eeApi.uploadGroupSession(serverId, channelId, deviceId, {
      session_id: distribution.distributionId,
      version: SENDER_KEY_PROTOCOL_VERSION,
      envelopes,
    });
  } catch (err) {
    await abandonUndistributedKey(channelId, userId, deviceId);
    throw err;
  }

  return true;
}

/**
 * Establishes the X3DH session for one recipient device if we don't have one.
 *
 * A dedicated signing_key is mandatory: identity keys are X25519 points and
 * cannot verify an Ed25519 prekey signature, so a bundle without one is
 * refused rather than verified against the wrong key type.
 */
async function ensureSessionForRecipient(
  recipient: SenderKeyRecipient
): Promise<void> {
  if (await signalProtocol.hasSessionFor(recipient.user_id, recipient.device_id)) {
    return;
  }
  if (!recipient.signing_key) {
    throw new LegacyDeviceError(recipient.user_id, recipient.device_id);
  }
  await signalProtocol.processPreKeyBundle(
    recipient.user_id,
    recipient.device_id,
    {
      identityKey: recipient.identity_key,
      signingKey: recipient.signing_key,
      signedPrekeyId: recipient.signed_prekey_id,
      signedPrekey: recipient.signed_prekey,
      signedPrekeySignature: recipient.signed_prekey_signature,
      oneTimePrekeyId: recipient.one_time_prekey_id ?? undefined,
      oneTimePrekey: recipient.one_time_prekey ?? undefined,
      registrationId: recipient.registration_id,
    }
  );
}

/**
 * A distribution was minted but never delivered. The key is already persisted
 * (createDistribution writes it), so blank its roster fingerprint and re-arm
 * the staleness mark: the next send then sees a fingerprint mismatch and does
 * a full re-mint instead of ratcheting forward under a distribution no member
 * holds. Best-effort — a storage failure here must not mask the original error.
 */
async function abandonUndistributedKey(
  channelId: string,
  userId: string,
  deviceId: string
): Promise<void> {
  markChannelRecipientsStale(channelId);
  try {
    const stranded = await keyStorage.getSenderKey(channelId, userId, deviceId);
    if (stranded) {
      stranded.recipientFingerprint = undefined;
      await keyStorage.saveSenderKey(stranded);
    }
  } catch (err) {
    console.error(
      "[channelEncryption] Failed to invalidate undistributed sender key:",
      err
    );
  }
}

// ──────────────────────────────────
// Decryption (Receiver Side)
// ──────────────────────────────────

/**
 * Decrypts an incoming E2EE channel message and parses the structured payload.
 *
 * The ciphertext field contains a JSON-serialized SenderKeyMessage.
 * It is decrypted with the sender's sender key.
 * After decryption, decodePayload separates content + file_keys.
 *
 * @param senderUserId - Sender user ID
 * @param channelId - Channel ID
 * @param ciphertext - JSON string SenderKeyMessage
 * @param senderDeviceId - Sender device ID
 * @returns Decrypted payload (content + file_keys) or null
 */
export async function decryptChannelMessage(
  senderUserId: string,
  channelId: string,
  ciphertext: string,
  senderDeviceId: string
): Promise<E2EEPayload | null> {
  // Parse the Sender Key message
  let senderKeyMsg: SenderKeyMessage;
  try {
    senderKeyMsg = JSON.parse(ciphertext);
  } catch {
    console.error("[channelEncryption] Failed to parse SenderKeyMessage");
    return null;
  }

  // If we don't have the sender's sender key, fetch it from the server
  try {
    await ensureSenderKeyForDecryption(
      channelId,
      senderUserId,
      senderDeviceId,
      senderKeyMsg.distributionId
    );
  } catch (err) {
    console.error(
      `[channelEncryption] Failed to fetch sender key for ${senderUserId}:${senderDeviceId}:`,
      err
    );
    return null;
  }

  // Decrypt with Sender Key
  const plaintext = await senderKeyProtocol.decryptGroupMessage(
    channelId,
    senderUserId,
    senderDeviceId,
    senderKeyMsg
  );

  if (plaintext === null) return null;

  // Parse structured payload — separate content + file_keys
  return decodePayload(plaintext);
}

/**
 * Ensures the sender's sender key is available.
 *
 * The distribution is sealed to THIS device, so obtaining it is a two-step
 * unwrap: fetch the row the server addressed to us, decrypt its envelope with
 * our Signal session for the sender device, then install the distribution.
 *
 * Also performs initialChainKey repair: sender keys stored before
 * initialChainKey existed cannot rewind, so out-of-order (historical) messages
 * fail. When we still hold such a key for THIS distribution, the original
 * chain key is recovered from the same sealed envelope. Note that this
 * re-opens an envelope we already consumed once; that is safe for the PreKey
 * case (which resets the receiving chain) and simply fails closed otherwise,
 * leaving the key exactly as it was.
 */
async function ensureSenderKeyForDecryption(
  channelId: string,
  senderUserId: string,
  senderDeviceId: string,
  distributionId: string
): Promise<void> {
  // Check whether a sender key exists and matches the correct distribution
  const existingKey = await keyStorage.getSenderKey(
    channelId,
    senderUserId,
    senderDeviceId
  );

  // ⛔ Install only what we do not already have. Rotation is the SENDER's
  // decision and reaches us as a NEW distributionId; there is no such thing as
  // an inbound key going stale on its own. This used to also reinstall when
  // needsRotationCheck reported age/count staleness, which reinstalled the
  // SAME distribution over itself — and since a sender key row is written
  // whole, that silently discarded the replay window proving which iterations
  // we had already accepted (security scan 2026-07-31, finding N-11). Waiting
  // out the 7-day age cap was enough to re-open every captured ciphertext.
  const needsKey = !existingKey || existingKey.distributionId !== distributionId;

  // Repair is needed if initialChainKey is missing — recovered from the
  // sealed distribution below.
  const needsInitialKeyRepair =
    existingKey &&
    !existingKey.initialChainKey &&
    existingKey.distributionId === distributionId;

  if (!needsKey && !needsInitialKeyRepair) return;

  const serverId = useServerStore.getState().activeServerId;
  if (!serverId) return;

  const myDeviceId = useE2EEStore.getState().localDeviceId;
  if (!myDeviceId) return;

  // Rows come back pre-filtered to this device by the server.
  const res = await e2eeApi.fetchGroupSessions(serverId, channelId, myDeviceId);
  if (!res.success || !res.data) return;

  const row = res.data.find(
    (s) =>
      s.sender_user_id === senderUserId &&
      s.sender_device_id === senderDeviceId &&
      s.session_id === distributionId
  );
  if (!row) return;

  let distribution: SenderKeyDistributionData;
  try {
    const wireMessage: SignalWireMessage = JSON.parse(row.ciphertext);
    const sealed = await signalProtocol.decryptMessage(
      senderUserId,
      senderDeviceId,
      wireMessage
    );
    distribution = JSON.parse(sealed);
  } catch (err) {
    console.error(
      "[channelEncryption] Failed to open sealed sender-key distribution:",
      err
    );
    return;
  }

  if (distribution.distributionId !== distributionId) return;

  if (needsKey) {
    await senderKeyProtocol.processDistribution(
      channelId,
      senderUserId,
      senderDeviceId,
      distribution
    );
    return;
  }

  if (needsInitialKeyRepair && existingKey) {
    // Preserve iteration/chainKey — only the rewind anchor is restored.
    existingKey.initialChainKey = fromBase64(distribution.chainKey);
    await keyStorage.saveSenderKey(existingKey);
  }
}

/**
 * Bulk-decrypts E2EE messages in a Message array.
 *
 * Called after fetchMessages/fetchOlderMessages.
 * Plaintext messages (encryption_version=0) are left untouched.
 * Messages that fail to decrypt are marked with content=null.
 *
 * After successful decryption:
 * - content + e2ee_file_keys are set on the message
 * - The message is written to the IndexedDB cache (for client-side search)
 *
 * @param messages - Raw message array from the backend
 * @returns Decrypted message array (same order)
 */
export async function decryptChannelMessages(
  messages: Message[]
): Promise<Message[]> {
  // Skip decryption if E2EE init is not complete (keys not yet generated).
  const e2eeStatus = useE2EEStore.getState().initStatus;
  if (e2eeStatus !== "ready") {
    return messages.map((msg) =>
      msg.encryption_version === 1 ? { ...msg, content: null } : msg
    );
  }

  const result: Message[] = [];
  const toCache: import("./types").CachedDecryptedMessage[] = [];

  for (const msg of messages) {
    if (
      msg.encryption_version === 1 &&
      msg.ciphertext &&
      msg.sender_device_id
    ) {
      try {
        const payload = await decryptChannelMessage(
          msg.user_id,
          msg.channel_id,
          msg.ciphertext,
          msg.sender_device_id
        );

        result.push({
          ...msg,
          content: payload?.content ?? null,
          e2ee_file_keys: payload?.file_keys,
        });

        // Successful decrypt → write to IndexedDB cache (for search)
        if (payload?.content) {
          toCache.push({
            messageId: msg.id,
            channelId: msg.channel_id,
            dmChannelId: null,
            content: payload.content,
            timestamp: new Date(msg.created_at).getTime(),
          });
        }
      } catch (err) {
        console.error(
          `[channelEncryption] Failed to decrypt msg ${msg.id}:`,
          err
        );
        // Decrypt failed — record as a decryption error
        useE2EEStore.getState().addDecryptionError({
          messageId: msg.id,
          channelId: msg.channel_id,
          error: err instanceof Error ? err.message : "Decryption failed",
          timestamp: Date.now(),
        });
        result.push({ ...msg, content: null });
      }
    } else {
      // Plaintext message — leave as-is
      result.push(msg);
    }
  }

  // Bulk cache write — performant via a single transaction
  if (toCache.length > 0) {
    keyStorage.cacheDecryptedMessages(toCache).catch((err) => {
      console.error("[channelEncryption] Failed to cache messages:", err);
    });
  }

  return result;
}
