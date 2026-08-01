/**
 * channelEncryption tests — the Sender-Key orchestration layer (post C-03).
 *
 * channelEncryption is the seam between messageStore/useWebSocket and the raw
 * Sender-Key primitives. It owns the *orchestration*, not the crypto:
 *   - deciding when to mint + upload a new distribution (age, count, protocol
 *     version, recipient-roster change),
 *   - SEALING that distribution once per recipient device inside that device's
 *     Signal session, and unwrapping our own envelope on first decrypt,
 *   - the initialChainKey repair for legacy stored keys,
 *   - and how per-message failures surface (return-null vs throw vs
 *     addDecryptionError) at the single- and bulk-decrypt levels.
 *
 * The crypto is REAL throughout: real signalProtocol (X25519 X3DH, Ed25519
 * bundle signatures, Double Ratchet), real senderKeyProtocol, real e2eePayload,
 * real base64. Only the outside world is mocked — keyStorage, the e2ee HTTP
 * API, and the two zustand stores.
 *
 * FOUR-STORE INVARIANT (extends the two-store rule inherited from
 * senderKeyProtocol.test.ts). Two collisions make a single shared store
 * dishonest here:
 *   1. A Sender Key is keyed by (channelId, senderUserId, senderDeviceId) — the
 *      sender's ratcheted outbound key and the receiver's installed inbound key
 *      land on the same tuple.
 *   2. A Signal session is keyed by (userId, deviceId) — Alice's session TO Bob
 *      and Bob's session TO Alice would overwrite each other.
 * So every participant gets an isolated in-memory store and an "active" pointer
 * flips between them. A receiver only ever holds what a sealed envelope
 * installed; if the seal were fake, nothing would decrypt.
 *
 * Cast: Alice sends. Bob and Carol are channel members. Eve is a third party —
 * she stands in for the SERVER OPERATOR: she sees every uploaded envelope and
 * must be able to open none of them.
 *
 * Signature/replay/tamper guards are NOT re-tested here — they live in
 * senderKeyProtocol.test.ts. Ratchet mechanics live in signalProtocol.test.ts.
 */

import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import type {
  StoredIdentityKeyPair,
  StoredSigningKeyPair,
  StoredSignedPreKey,
  StoredPreKey,
  StoredSession,
  StoredSenderKey,
  TrustedIdentity,
  RegistrationData,
  SenderKeyMessage,
  SenderKeyDistributionData,
  SignalWireMessage,
  CachedDecryptedMessage,
} from "./types";
import { SENDER_KEY_ROTATION_MESSAGES } from "./types";
import type {
  ChannelGroupSessionResponse,
  SenderKeyRecipient,
} from "../types/e2ee";
import type { Message } from "../types/message";
import type { PublicUser } from "../types/user";
import type { MemberWithRoles } from "../types/role";
import type { ChannelPermissionOverride } from "../types/channel";
import type { EncryptedFileMeta } from "./fileEncryption";
import { Permissions } from "../utils/permissions";

// ──────────────────────────────────
// Store shapes
// ──────────────────────────────────

/** One participant's isolated stand-in for IndexedDB. */
type Store = {
  identity: StoredIdentityKeyPair | null;
  signing: StoredSigningKeyPair | null;
  registration: RegistrationData | null;
  signedPreKeys: Map<number, StoredSignedPreKey>;
  preKeys: Map<number, StoredPreKey>;
  sessions: Map<string, StoredSession>;
  trusted: Map<string, TrustedIdentity>;
  senderKeys: Map<string, StoredSenderKey>;
  meta: Map<string, unknown>;
};

/**
 * A stored envelope row, as the SERVER would hold it. The recipient columns
 * exist only so the mock can do the server's filtering; the GET response type
 * deliberately does not carry them.
 */
type ServerRow = {
  channel_id: string;
  recipient_device_id: string;
} & ChannelGroupSessionResponse;

/** The upload body shape pinned by the wire contract. */
type UploadBody = {
  session_id: string;
  version: number;
  envelopes: Array<{
    recipient_user_id: string;
    recipient_device_id: string;
    message_type: number;
    ciphertext: string;
  }>;
};

const compositeKey = (userId: string, deviceId: string): string =>
  `${userId}:${deviceId}`;

const senderKeyId = (
  channelId: string,
  userId: string,
  deviceId: string
): string => `${channelId}:${userId}:${deviceId}`;

const h = vi.hoisted(() => {
  const makeStore = (): Store => ({
    identity: null,
    signing: null,
    registration: null,
    signedPreKeys: new Map(),
    preKeys: new Map(),
    sessions: new Map(),
    trusted: new Map(),
    senderKeys: new Map(),
    meta: new Map(),
  });
  const alice = makeStore();
  return {
    alice,
    bob: makeStore(),
    carol: makeStore(),
    eve: makeStore(),
    /** Reassigned by switchTo(); every mocked keyStorage call reads this. */
    active: alice,
    /** Mirrors e2eeStore.localDeviceId for whoever is currently "us". */
    localDeviceId: "",
    /** uploadGroupSession carries no sender_user_id — the server derives it. */
    deviceOwner: {} as Record<string, string>,
    /** Envelope rows the server holds. */
    serverRows: [] as ServerRow[],
    /** What GET sender-key-recipients returns. */
    roster: [] as SenderKeyRecipient[],
    /** Messages handed to keyStorage.cacheDecryptedMessages. */
    cached: [] as CachedDecryptedMessage[],
    /** Toggle to simulate fetchGroupSessions failing. */
    fetchSuccess: true,
    /** Mutable useServerStore.getState().activeServerId. */
    activeServerId: "server-1" as string | null,
    /**
     * Mutable useMemberStore state — the client's OWN view of who is on the
     * server, which is what the empty-roster cross-check weighs the server's
     * roster answer against.
     */
    membersByServer: {} as Record<string, MemberWithRoles[]>,
    loadingServers: new Set<string>(),
    /** Mutable useChannelPermissionStore state. */
    fetchedChannels: new Set<string>(),
    overridesByChannel: {} as Record<string, ChannelPermissionOverride[]>,
    /** Mutable useE2EEStore.getState().initStatus. */
    initStatus: "ready" as string,
    addDecryptionError: vi.fn(),
    markIncompatibleDevice: vi.fn(),
  };
});

// ── keyStorage: per-participant in-memory stand-in for IndexedDB. ──
vi.mock("./keyStorage", () => ({
  saveIdentityKeyPair: vi.fn(async (kp: StoredIdentityKeyPair) => {
    h.active.identity = kp;
  }),
  getIdentityKeyPair: vi.fn(async () => h.active.identity),
  saveSigningKeyPair: vi.fn(async (kp: StoredSigningKeyPair) => {
    h.active.signing = kp;
  }),
  getSigningKeyPair: vi.fn(async () => h.active.signing),
  saveSignedPreKey: vi.fn(async (spk: StoredSignedPreKey) => {
    h.active.signedPreKeys.set(spk.id, spk);
  }),
  getSignedPreKey: vi.fn(
    async (id: number) => h.active.signedPreKeys.get(id) ?? null
  ),
  savePreKeys: vi.fn(async (pks: StoredPreKey[]) => {
    for (const pk of pks) h.active.preKeys.set(pk.id, pk);
  }),
  getPreKey: vi.fn(async (id: number) => h.active.preKeys.get(id) ?? null),
  getRegistrationData: vi.fn(async () => h.active.registration),
  getSession: vi.fn(
    async (userId: string, deviceId: string) =>
      h.active.sessions.get(compositeKey(userId, deviceId)) ?? null
  ),
  saveSession: vi.fn(async (s: StoredSession) => {
    h.active.sessions.set(compositeKey(s.userId, s.deviceId), s);
  }),
  hasSession: vi.fn(async (userId: string, deviceId: string) =>
    h.active.sessions.has(compositeKey(userId, deviceId))
  ),
  deleteSession: vi.fn(async (userId: string, deviceId: string) => {
    h.active.sessions.delete(compositeKey(userId, deviceId));
  }),
  deleteAllSessionsForUser: vi.fn(async (userId: string) => {
    for (const k of [...h.active.sessions.keys()]) {
      if (k.startsWith(`${userId}:`)) h.active.sessions.delete(k);
    }
  }),
  getTrustedIdentity: vi.fn(
    async (userId: string, deviceId: string) =>
      h.active.trusted.get(compositeKey(userId, deviceId)) ?? null
  ),
  saveTrustedIdentity: vi.fn(async (t: TrustedIdentity) => {
    h.active.trusted.set(compositeKey(t.userId, t.deviceId), t);
  }),
  saveSenderKey: vi.fn(async (sk: StoredSenderKey) => {
    h.active.senderKeys.set(
      senderKeyId(sk.channelId, sk.senderUserId, sk.senderDeviceId),
      sk
    );
  }),
  getSenderKey: vi.fn(
    async (channelId: string, userId: string, deviceId: string) =>
      h.active.senderKeys.get(senderKeyId(channelId, userId, deviceId)) ?? null
  ),
  deleteAllSenderKeysForChannel: vi.fn(async (channelId: string) => {
    for (const k of [...h.active.senderKeys.keys()]) {
      if (k.startsWith(`${channelId}:`)) h.active.senderKeys.delete(k);
    }
  }),
  setMetadata: vi.fn(async (key: string, value: unknown) => {
    h.active.meta.set(key, value);
  }),
  getMetadata: vi.fn(async (key: string) => h.active.meta.get(key) ?? null),
  cacheDecryptedMessage: vi.fn(async () => {}),
  getCachedDecryptedMessage: vi.fn(async () => null),
  cacheDecryptedMessages: vi.fn(async (msgs: CachedDecryptedMessage[]) => {
    h.cached.push(...msgs);
  }),
}));

// ── e2ee HTTP API: an in-memory envelope table + roster. ──
vi.mock("../api/e2ee", () => ({
  uploadGroupSession: vi.fn(
    async (
      _serverId: string,
      channelId: string,
      deviceId: string,
      req: UploadBody
    ) => {
      for (const env of req.envelopes) {
        h.serverRows.push({
          channel_id: channelId,
          // The upload API does not carry the user id; the server derives it
          // from the authenticated device. Mirrored with a device→owner map.
          sender_user_id: h.deviceOwner[deviceId] ?? "unknown",
          sender_device_id: deviceId,
          recipient_device_id: env.recipient_device_id,
          session_id: req.session_id,
          version: req.version,
          message_type: env.message_type,
          ciphertext: env.ciphertext,
          created_at: "2026-01-01T00:00:00.000Z",
        });
      }
      return { success: true };
    }
  ),
  fetchGroupSessions: vi.fn(
    async (_serverId: string, channelId: string, deviceId: string) => {
      if (!h.fetchSuccess) return { success: false };
      // The server filters by device_id, so the response drops the recipient
      // columns entirely — the client must not rely on them.
      const data: ChannelGroupSessionResponse[] = h.serverRows
        .filter(
          (r) => r.channel_id === channelId && r.recipient_device_id === deviceId
        )
        .map((r) => ({
          sender_user_id: r.sender_user_id,
          sender_device_id: r.sender_device_id,
          session_id: r.session_id,
          version: r.version,
          message_type: r.message_type,
          ciphertext: r.ciphertext,
          created_at: r.created_at,
        }));
      return { success: true, data };
    }
  ),
  fetchSenderKeyRecipients: vi.fn(async () => ({
    success: true,
    data: h.roster,
  })),
  // dmEncryption/deviceManager pull these in; never exercised here.
  fetchPreKeyBundles: vi.fn(async () => ({ success: true, data: [] })),
}));

vi.mock("../api/clientLog", () => ({ logToServer: vi.fn() }));

// ── zustand stores: minimal mutable holders. ──
vi.mock("../stores/serverStore", () => ({
  useServerStore: {
    getState: () => ({ activeServerId: h.activeServerId }),
  },
}));

vi.mock("../stores/e2eeStore", () => ({
  useE2EEStore: {
    getState: () => ({
      initStatus: h.initStatus,
      localDeviceId: h.localDeviceId,
      addDecryptionError: h.addDecryptionError,
      markIncompatibleDevice: h.markIncompatibleDevice,
    }),
  },
}));

vi.mock("../stores/memberStore", () => ({
  useMemberStore: {
    getState: () => ({
      membersByServer: h.membersByServer,
      loadingServers: h.loadingServers,
    }),
  },
}));

vi.mock("../stores/channelPermissionStore", () => ({
  useChannelPermissionStore: {
    getState: () => ({
      fetchedChannels: h.fetchedChannels,
      getOverrides: (channelId: string) =>
        h.overridesByChannel[channelId] ?? [],
    }),
  },
}));

import {
  encryptChannelMessage,
  decryptChannelMessage,
  decryptChannelMessages,
  markChannelRecipientsStale,
  markAllChannelRecipientsStale,
  SuppressedRosterError,
} from "./channelEncryption";
import { encodePayload } from "./e2eePayload";
import * as keyStorage from "./keyStorage";
import * as e2eeApi from "../api/e2ee";
import {
  generateAllKeys,
  decryptMessage,
  toBase64,
} from "./signalProtocol";

// ──────────────────────────────────
// Cast + harness
// ──────────────────────────────────

const CH = "channel-1";
const SERVER_ID = "server-1";

type GeneratedKeys = Awaited<ReturnType<typeof generateAllKeys>>;

type Participant = {
  userId: string;
  deviceId: string;
  store: Store;
  keys: GeneratedKeys;
};

function participant(
  userId: string,
  deviceId: string,
  store: Store
): Participant {
  return { userId, deviceId, store, keys: null as unknown as GeneratedKeys };
}

const ALICE = participant("user-alice", "device-alice-1", h.alice);
const BOB = participant("user-bob", "device-bob-1", h.bob);
const CAROL = participant("user-carol", "device-carol-1", h.carol);
const EVE = participant("user-eve", "device-eve-1", h.eve);
const EVERYONE = [ALICE, BOB, CAROL, EVE];

/** Point the mocked storage layer (and "our" device id) at one participant. */
function switchTo(p: Participant): void {
  h.active = p.store;
  h.localDeviceId = p.deviceId;
}

/**
 * A roster row as the server would serve it: the participant's REAL public
 * bundle, so Ed25519 verification and X3DH run for real. `legacy` drops the
 * dedicated signing key, reproducing a device registered before it existed.
 */
function rosterEntry(
  p: Participant,
  opts: { legacy?: boolean } = {}
): SenderKeyRecipient {
  return {
    user_id: p.userId,
    device_id: p.deviceId,
    registration_id: p.keys.registrationId,
    identity_key: p.keys.identityPublicKey,
    signing_key: opts.legacy ? null : p.keys.signingPublicKey,
    signed_prekey_id: p.keys.signedPreKey.id,
    signed_prekey: p.keys.signedPreKey.publicKey,
    signed_prekey_signature: p.keys.signedPreKey.signature,
    one_time_prekey_id: p.keys.oneTimePreKeys[0].id,
    one_time_prekey: p.keys.oneTimePreKeys[0].publicKey,
  };
}

/** What an ordinary member carries: view + read + send, nothing special. */
const MEMBER_PERMS =
  Permissions.ViewChannel | Permissions.ReadMessages | Permissions.SendMessages;

const EVERYONE_ROLE = "role-everyone";

/**
 * A member row as the client's own member list would hold it. `roleId`/`perms`
 * exist so a test can build a member the channel overrides can single out.
 */
function memberRow(
  p: Participant,
  opts: { roleId?: string; perms?: number } = {}
): MemberWithRoles {
  const roleId = opts.roleId ?? EVERYONE_ROLE;
  const perms = opts.perms ?? MEMBER_PERMS;
  return {
    id: p.userId,
    username: p.userId,
    display_name: null,
    avatar_url: null,
    status: "online",
    custom_status: null,
    created_at: "2026-01-01T00:00:00.000Z",
    roles: [
      {
        id: roleId,
        name: roleId,
        color: "#ffffff",
        position: 0,
        permissions: perms,
        is_default: roleId === EVERYONE_ROLE,
        is_owner: false,
        mentionable: false,
      },
    ],
    effective_permissions: perms,
  };
}

/** The body handed to uploadGroupSession on the nth call (0-based). */
function uploadBody(n = 0): UploadBody {
  const call = vi.mocked(e2eeApi.uploadGroupSession).mock.calls[n];
  expect(call).toBeDefined();
  return call[3] as unknown as UploadBody;
}

function uploadCount(): number {
  return vi.mocked(e2eeApi.uploadGroupSession).mock.calls.length;
}

function aliceSenderKey(): StoredSenderKey {
  const key = h.alice.senderKeys.get(
    senderKeyId(CH, ALICE.userId, ALICE.deviceId)
  );
  expect(key).toBeDefined();
  return key!;
}

/** Alice sends; the caller is responsible for switching stores afterwards. */
async function aliceSends(text: string): Promise<SenderKeyMessage> {
  switchTo(ALICE);
  return encryptChannelMessage(
    CH,
    ALICE.userId,
    ALICE.deviceId,
    encodePayload(text)
  );
}

async function receiverReads(
  p: Participant,
  msg: SenderKeyMessage
): Promise<string | null> {
  switchTo(p);
  const payload = await decryptChannelMessage(
    ALICE.userId,
    CH,
    JSON.stringify(msg),
    ALICE.deviceId
  );
  return payload?.content ?? null;
}

/** Minimal Message; author is a stub since decrypt only reads scalar fields. */
function baseMessage(id: string, overrides: Partial<Message>): Message {
  return {
    id,
    channel_id: CH,
    user_id: ALICE.userId,
    content: null,
    edited_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    reply_to_id: null,
    referenced_message: null,
    author: {} as PublicUser,
    attachments: [],
    mentions: [],
    role_mentions: [],
    reactions: [],
    encryption_version: 0,
    ...overrides,
  };
}

function plaintextMsg(id: string, content: string): Message {
  return baseMessage(id, { encryption_version: 0, content });
}

function e2eeMsg(
  id: string,
  cipher: SenderKeyMessage | string,
  userId = ALICE.userId,
  deviceId = ALICE.deviceId
): Message {
  return baseMessage(id, {
    encryption_version: 1,
    user_id: userId,
    sender_device_id: deviceId,
    ciphertext: typeof cipher === "string" ? cipher : JSON.stringify(cipher),
  });
}

function sampleMeta(name = "photo.png"): EncryptedFileMeta {
  return {
    key: "a2V5LWJhc2U2NA==",
    iv: "aXYtYmFzZTY0",
    filename: name,
    mimeType: "image/png",
    originalSize: 2048,
    digest: "deadbeefcafef00d",
  };
}

// Identity/prekey material is expensive and immutable, so it is generated once
// and only the mutable parts of each store are reset per test.
beforeAll(async () => {
  for (const p of EVERYONE) {
    switchTo(p);
    p.keys = await generateAllKeys();
    h.deviceOwner[p.deviceId] = p.userId;
  }
});

beforeEach(() => {
  vi.clearAllMocks();
  for (const p of EVERYONE) {
    p.store.sessions.clear();
    p.store.trusted.clear();
    p.store.senderKeys.clear();
    p.store.meta.clear();
  }
  h.serverRows.length = 0;
  h.cached.length = 0;
  h.fetchSuccess = true;
  h.activeServerId = SERVER_ID;
  h.initStatus = "ready";
  // Default: the client's own member list is UNKNOWN (nothing fetched yet), so
  // the empty-roster cross-check has nothing to weigh against and every test
  // that does not opt in sees the pre-guard behaviour. Tests that exercise the
  // guard populate these explicitly.
  h.membersByServer = {};
  h.loadingServers.clear();
  h.fetchedChannels.clear();
  h.overridesByChannel = {};
  // Default channel membership: Alice sends, Bob receives. Eve is never on it.
  h.roster = [rosterEntry(BOB)];
  // channelEncryption's staleness bookkeeping is module-global and survives
  // between tests; bumping the epoch restores the "fresh page load" state.
  markAllChannelRecipientsStale();
  switchTo(ALICE);
});

// ──────────────────────────────────
// C-03: the server must not be able to read the group key
// ──────────────────────────────────

describe("channelEncryption — sealed sender-key distribution (pentest C-03)", () => {
  it("never puts the group chain key on the wire in any readable form", async () => {
    await aliceSends("top secret");

    const key = aliceSenderKey();
    expect(key.initialChainKey).toBeDefined();
    // chainKey has already ratcheted once (one message sent); initialChainKey
    // is the exact value the distribution carries. Both must be absent.
    const chainKeyB64 = toBase64(key.chainKey);
    const initialChainKeyB64 = toBase64(key.initialChainKey!);
    const initialChainKeyHex = Array.from(key.initialChainKey!)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    // Flatten the ENTIRE request body — session id, version, every envelope.
    const wire = JSON.stringify(uploadBody());

    expect(wire).not.toContain(chainKeyB64);
    expect(wire).not.toContain(initialChainKeyB64);
    expect(wire).not.toContain(initialChainKeyHex);
    // The v1 body shipped the distribution as a readable `session_data` blob.
    expect(wire).not.toContain("session_data");
    expect(uploadBody().version).toBe(2);
  });

  it("the sealed envelope really carries that key — only Bob can open it", async () => {
    await aliceSends("hello");
    const key = aliceSenderKey();
    const body = uploadBody();

    const envelope = body.envelopes.find(
      (e) => e.recipient_device_id === BOB.deviceId
    );
    expect(envelope).toBeDefined();

    // Bob opens his own envelope with his Signal session and finds exactly the
    // chain key that never appeared in the request body.
    switchTo(BOB);
    const sealed = await decryptMessage(
      ALICE.userId,
      ALICE.deviceId,
      JSON.parse(envelope!.ciphertext) as SignalWireMessage
    );
    const distribution = JSON.parse(sealed) as SenderKeyDistributionData;

    expect(distribution.version).toBe(2);
    expect(distribution.distributionId).toBe(body.session_id);
    expect(distribution.chainKey).toBe(toBase64(key.initialChainKey!));
  });

  it("a non-member sees every envelope and can open none of them", async () => {
    h.roster = [rosterEntry(BOB), rosterEntry(CAROL)];
    await aliceSends("members only");

    const body = uploadBody();
    // Eve — the server-operator stand-in — is addressed by nothing.
    expect(
      body.envelopes.some((e) => e.recipient_device_id === EVE.deviceId)
    ).toBe(false);

    // ...and holding all the ciphertext does not help her.
    switchTo(EVE);
    for (const envelope of body.envelopes) {
      await expect(
        decryptMessage(
          ALICE.userId,
          ALICE.deviceId,
          JSON.parse(envelope.ciphertext) as SignalWireMessage
        )
      ).rejects.toThrow();
    }
  });

  it("emits one envelope per roster device and never one for the sending device", async () => {
    h.roster = [rosterEntry(BOB), rosterEntry(CAROL)];
    await aliceSends("fanout");

    const body = uploadBody();
    expect(body.envelopes).toHaveLength(h.roster.length);
    expect(body.envelopes.map((e) => e.recipient_device_id).sort()).toEqual(
      [BOB.deviceId, CAROL.deviceId].sort()
    );

    // Defence in depth: even if the server leaks our own device into the
    // roster, we skip it — there is no Signal session to self.
    h.roster = [rosterEntry(BOB), rosterEntry(CAROL), rosterEntry(ALICE)];
    markChannelRecipientsStale(CH);
    await aliceSends("fanout again");

    const second = uploadBody(1);
    expect(second.envelopes).toHaveLength(2);
    expect(
      second.envelopes.some((e) => e.recipient_device_id === ALICE.deviceId)
    ).toBe(false);
  });

  it("skips a legacy device, flags it, and still seals for everyone else", async () => {
    // Bob's device predates the dedicated Ed25519 signing key.
    h.roster = [rosterEntry(BOB, { legacy: true }), rosterEntry(CAROL)];
    const msg = await aliceSends("carol can read this");

    const body = uploadBody();
    expect(body.envelopes).toHaveLength(1);
    expect(body.envelopes[0].recipient_device_id).toBe(CAROL.deviceId);
    expect(h.markIncompatibleDevice).toHaveBeenCalledWith(
      BOB.userId,
      BOB.deviceId
    );

    // One outdated device must not lock the channel for the others.
    expect(await receiverReads(CAROL, msg)).toBe("carol can read this");
  });

  it("sends in a solo channel without uploading an empty envelope set", async () => {
    // A channel where we are the only member on the only device: there is
    // nobody to seal for, which is NOT the same failure as "everyone is
    // legacy". No request is made — an empty envelope set is not a
    // distribution — but the message must still encrypt.
    h.roster = [];
    // The client's own member list agrees we are alone, so the empty roster is
    // solitude and not the suppression anomaly guarded below.
    h.membersByServer[SERVER_ID] = [memberRow(ALICE)];
    h.fetchedChannels.add(CH);
    const msg = await aliceSends("talking to myself");

    expect(msg.iteration).toBe(0);
    expect(uploadCount()).toBe(0);
    // The sender reads its own history back through the outbound key.
    expect(await receiverReads(ALICE, msg)).toBe("talking to myself");

    // Still armed: the next send re-reads the roster, so a transient empty
    // response self-heals instead of stranding real members.
    h.roster = [rosterEntry(BOB)];
    const second = await aliceSends("now with company");
    expect(second.distributionId).not.toBe(msg.distributionId);
    expect(uploadCount()).toBe(1);
    expect(uploadBody().envelopes).toHaveLength(1);
    expect(await receiverReads(BOB, second)).toBe("now with company");
  });

  // ── Empty roster as a censorship primitive ──
  //
  // The roster is the SERVER's answer to "who must receive this key". Reading
  // an empty one as "solo channel" would let a hostile server mute one member
  // of one channel invisibly: we mint a key, upload no envelope, and send. The
  // sender's own outbound key decrypts the sender's own message, so the UI
  // looks perfectly healthy while nobody in the channel can read a word. The
  // client already knows the member list, so it can call that bluff.

  it("refuses to send when an empty roster contradicts the member list", async () => {
    h.roster = [];
    h.membersByServer[SERVER_ID] = [memberRow(ALICE), memberRow(BOB)];
    h.fetchedChannels.add(CH);
    switchTo(ALICE);

    await expect(
      encryptChannelMessage(
        CH,
        ALICE.userId,
        ALICE.deviceId,
        encodePayload("can anyone hear me")
      )
    ).rejects.toThrow(SuppressedRosterError);

    // Nothing left the device...
    expect(uploadCount()).toBe(0);
    // ...and no key was minted either: a key stranded here would be ratcheted
    // forward by the next send, which is exactly the silent state we refuse.
    expect(h.alice.senderKeys.size).toBe(0);
  });

  it("also refuses when the roster contains nothing but our own device", async () => {
    // Same suppression, one step subtler: a non-empty roster that yields zero
    // sealable recipients uploads exactly as many envelopes as an empty one.
    h.roster = [rosterEntry(ALICE)];
    h.membersByServer[SERVER_ID] = [memberRow(ALICE), memberRow(BOB)];
    h.fetchedChannels.add(CH);
    switchTo(ALICE);

    await expect(
      encryptChannelMessage(CH, ALICE.userId, ALICE.deviceId, "nope")
    ).rejects.toThrow(SuppressedRosterError);
    expect(uploadCount()).toBe(0);
  });

  it("keeps the solo path when the other members cannot read the channel", async () => {
    // A private channel (@everyone denied ViewChannel) has a legitimately
    // empty roster on a crowded server. Cross-checking raw member COUNT would
    // make such a channel permanently unsendable, so the check resolves the
    // same read gate the server's roster query uses.
    h.roster = [];
    h.membersByServer[SERVER_ID] = [
      memberRow(ALICE, { roleId: "role-admin", perms: Permissions.Admin }),
      memberRow(BOB),
    ];
    h.overridesByChannel[CH] = [
      {
        channel_id: CH,
        role_id: EVERYONE_ROLE,
        allow: 0,
        deny: Permissions.ViewChannel,
      },
    ];
    h.fetchedChannels.add(CH);

    const msg = await aliceSends("private notes");

    expect(uploadCount()).toBe(0);
    expect(await receiverReads(ALICE, msg)).toBe("private notes");
  });

  it("keeps the solo path while the member list is still unknown", async () => {
    // Cold start / mid-switch: with no member list there is nothing to weigh
    // the roster against. "Unknown" must not read as "nobody else" — but it
    // must not block every send either, so the historical behaviour stands.
    h.roster = [];
    h.fetchedChannels.add(CH);

    const msg = await aliceSends("cold start");

    expect(msg.iteration).toBe(0);
    expect(uploadCount()).toBe(0);
  });

  it("keeps the solo path while the channel's overrides are unknown", async () => {
    // Overrides decide who can read a private channel. Unfetched overrides
    // make a locked-down channel look world-readable, which would turn the
    // guard into a false alarm — so an unfetched channel is "unknown" too.
    h.roster = [];
    h.membersByServer[SERVER_ID] = [memberRow(ALICE), memberRow(BOB)];
    // h.fetchedChannels deliberately left without CH.

    const msg = await aliceSends("overrides not loaded");

    expect(msg.iteration).toBe(0);
    expect(uploadCount()).toBe(0);
  });

  it("refuses on the roster RE-CHECK too, not only when a rotation is due", async () => {
    // The nastiest ordering: the key was minted while the channel was
    // genuinely solo, so its fingerprint is the fingerprint of an empty
    // roster. Bob then joins and the server starts suppressing him. The
    // fingerprint still MATCHES, so no rotation is due and the mint-time
    // branch is never reached — the check has to live on the roster read
    // itself or this send goes out unreadable.
    h.roster = [];
    h.membersByServer[SERVER_ID] = [memberRow(ALICE)];
    h.fetchedChannels.add(CH);
    await aliceSends("alone so far");
    expect(uploadCount()).toBe(0);

    // Bob joins (member list updates), the server keeps claiming nobody.
    h.membersByServer[SERVER_ID] = [memberRow(ALICE), memberRow(BOB)];
    markChannelRecipientsStale(CH);
    switchTo(ALICE);

    await expect(
      encryptChannelMessage(CH, ALICE.userId, ALICE.deviceId, "hi bob")
    ).rejects.toThrow(SuppressedRosterError);
    expect(uploadCount()).toBe(0);
  });

  it("refuses to send when every recipient device is legacy", async () => {
    h.roster = [
      rosterEntry(BOB, { legacy: true }),
      rosterEntry(CAROL, { legacy: true }),
    ];
    switchTo(ALICE);

    await expect(
      encryptChannelMessage(CH, ALICE.userId, ALICE.deviceId, "nope")
    ).rejects.toThrow(/legacy E2EE format/i);
    expect(uploadCount()).toBe(0);
  });
});

// ──────────────────────────────────
// Send path: rotation policy
// ──────────────────────────────────

describe("channelEncryption — rotation policy", () => {
  it("mints and uploads a distribution on the first message (iteration 0)", async () => {
    const msg = await aliceSends("first");

    expect(msg.iteration).toBe(0);
    expect(uploadCount()).toBe(1);

    const call = vi.mocked(e2eeApi.uploadGroupSession).mock.calls[0];
    expect(call[0]).toBe(SERVER_ID);
    expect(call[1]).toBe(CH);
    expect(call[2]).toBe(ALICE.deviceId);
    expect(uploadBody().session_id).toBe(msg.distributionId);
  });

  // CONTRACT PIN. The server 400s a roster request without ?device_id= — it is
  // the only way to tell which of the caller's devices is asking, so the roster
  // can exclude that one device while still listing the caller's OTHER devices.
  //
  // This exists because the mock ignores its arguments: every other assertion
  // here checks the CALL COUNT, so dropping the third argument would leave the
  // whole suite green while every roster fetch 400'd in production. The client
  // and server halves of this feature were written in parallel against a
  // written contract, and this is exactly where they drifted apart once.
  it("passes the sending device id to the roster endpoint (server requires it)", async () => {
    await aliceSends("first");

    const rosterCall = vi.mocked(e2eeApi.fetchSenderKeyRecipients).mock
      .calls[0];
    expect(rosterCall[0]).toBe(SERVER_ID);
    expect(rosterCall[1]).toBe(CH);
    expect(rosterCall[2]).toBe(ALICE.deviceId);
  });

  it("reuses the existing key on the second message (no re-upload, iteration advances)", async () => {
    const first = await aliceSends("a");
    const second = await aliceSends("b");

    expect(first.iteration).toBe(0);
    expect(second.iteration).toBe(1);
    expect(second.distributionId).toBe(first.distributionId);
    expect(uploadCount()).toBe(1);
    // The roster was read once (at mint) and not again — no key change, no
    // staleness mark.
    expect(e2eeApi.fetchSenderKeyRecipients).toHaveBeenCalledTimes(1);
  });

  it("rejects encryption when there is no active server", async () => {
    h.activeServerId = null;
    switchTo(ALICE);

    await expect(
      encryptChannelMessage(CH, ALICE.userId, ALICE.deviceId, "x")
    ).rejects.toThrow(/No active server/);
    expect(uploadCount()).toBe(0);
  });

  it("rotates to a new distribution once the message-count cap is reached", async () => {
    const first = await aliceSends("a");
    expect(uploadCount()).toBe(1);

    // Force the stored outbound key to the rotation threshold.
    const sk = await keyStorage.getSenderKey(CH, ALICE.userId, ALICE.deviceId);
    expect(sk).not.toBeNull();
    sk!.iteration = SENDER_KEY_ROTATION_MESSAGES;
    await keyStorage.saveSenderKey(sk!);

    const second = await aliceSends("b");

    expect(second.distributionId).not.toBe(first.distributionId);
    expect(second.iteration).toBe(0);
    expect(uploadCount()).toBe(2);
  });

  it("re-checks the roster when marked stale, but only rotates if it moved", async () => {
    h.roster = [rosterEntry(BOB), rosterEntry(CAROL)];
    const first = await aliceSends("one");
    expect(uploadCount()).toBe(1);
    expect(e2eeApi.fetchSenderKeyRecipients).toHaveBeenCalledTimes(1);

    // Marked stale, roster UNCHANGED → the fingerprint matches, so the key is
    // kept and we keep ratcheting. Re-check costs one GET, not a rotation.
    markChannelRecipientsStale(CH);
    const second = await aliceSends("two");
    expect(second.distributionId).toBe(first.distributionId);
    expect(second.iteration).toBe(1);
    expect(uploadCount()).toBe(1);
    expect(e2eeApi.fetchSenderKeyRecipients).toHaveBeenCalledTimes(2);

    // A device actually joins → fingerprint moves → full rotation, and the new
    // member is in the envelope set.
    h.roster = [rosterEntry(BOB), rosterEntry(CAROL), rosterEntry(EVE)];
    markChannelRecipientsStale(CH);
    const third = await aliceSends("three");

    expect(third.distributionId).not.toBe(first.distributionId);
    expect(third.iteration).toBe(0);
    expect(uploadCount()).toBe(2);
    expect(uploadBody(1).envelopes).toHaveLength(3);
    expect(
      uploadBody(1).envelopes.map((e) => e.recipient_device_id).sort()
    ).toEqual([BOB.deviceId, CAROL.deviceId, EVE.deviceId].sort());
  });

  it("markAllChannelRecipientsStale arms exactly one re-check per channel", async () => {
    const first = await aliceSends("one");
    expect(e2eeApi.fetchSenderKeyRecipients).toHaveBeenCalledTimes(1);

    markAllChannelRecipientsStale();
    const second = await aliceSends("two");
    expect(second.distributionId).toBe(first.distributionId);
    expect(e2eeApi.fetchSenderKeyRecipients).toHaveBeenCalledTimes(2);

    // The mark is consumed: a third send does not re-read the roster again.
    await aliceSends("three");
    expect(e2eeApi.fetchSenderKeyRecipients).toHaveBeenCalledTimes(2);
    expect(uploadCount()).toBe(1);
  });
});

// ──────────────────────────────────
// Version enforcement — the outbound/inbound asymmetry
// ──────────────────────────────────

describe("channelEncryption — protocol-version enforcement is outbound-only", () => {
  it("force-rotates an OUTBOUND key that predates the v2 format", async () => {
    const first = await aliceSends("v2 era");
    expect(uploadCount()).toBe(1);

    // Simulate a key minted before v2: its chain key was uploaded in the clear,
    // so it must never be used again.
    switchTo(ALICE);
    aliceSenderKey().protocolVersion = undefined;

    const second = await aliceSends("after upgrade");
    expect(second.distributionId).not.toBe(first.distributionId);
    expect(second.iteration).toBe(0);
    expect(uploadCount()).toBe(2);
  });

  it("REGRESSION LOCK: an INBOUND key with no version is never treated as stale", async () => {
    // If the version check ever leaks into needsRotationCheck, every legacy
    // inbound key starts demanding a re-fetch it can never satisfy — a v1
    // distribution row no longer exists server-side — and the replay window
    // gets reset on every single message.
    const m0 = await aliceSends("first");
    const m1 = await aliceSends("second");

    expect(await receiverReads(BOB, m0)).toBe("first");

    switchTo(BOB);
    const inbound = h.bob.senderKeys.get(
      senderKeyId(CH, ALICE.userId, ALICE.deviceId)
    );
    expect(inbound).toBeDefined();
    // Downgrade it to the pre-v2 shape, exactly as it would sit in a user's
    // IndexedDB after upgrading the app.
    inbound!.protocolVersion = undefined;

    const fetchesBefore = vi.mocked(e2eeApi.fetchGroupSessions).mock.calls
      .length;

    expect(await receiverReads(BOB, m1)).toBe("second");

    // No re-fetch at all: the stored key was accepted as-is.
    expect(vi.mocked(e2eeApi.fetchGroupSessions).mock.calls).toHaveLength(
      fetchesBefore
    );
    // ...and the key was not reinstalled from scratch.
    expect(
      h.bob.senderKeys.get(senderKeyId(CH, ALICE.userId, ALICE.deviceId))
    ).toBe(inbound);
  });
});

// ──────────────────────────────────
// Receive path
// ──────────────────────────────────

describe("channelEncryption — receive path", () => {
  it("round-trips: Bob fetches the envelope addressed to him and decrypts", async () => {
    const msg = await aliceSends("hello from alice");

    // Bob starts with no sender key — the only path to plaintext is fetching
    // and unwrapping his own envelope.
    expect(await receiverReads(BOB, msg)).toBe("hello from alice");

    // The GET is scoped to Bob's device, which is what lets the server filter.
    expect(e2eeApi.fetchGroupSessions).toHaveBeenCalledWith(
      SERVER_ID,
      CH,
      BOB.deviceId
    );
  });

  it("installs the distribution once, then decrypts later messages without re-fetching", async () => {
    const m0 = await aliceSends("m0");
    const m1 = await aliceSends("m1");

    expect(await receiverReads(BOB, m0)).toBe("m0");
    const afterFirst = vi.mocked(e2eeApi.fetchGroupSessions).mock.calls.length;
    expect(afterFirst).toBe(1);

    expect(await receiverReads(BOB, m1)).toBe("m1");
    expect(vi.mocked(e2eeApi.fetchGroupSessions).mock.calls).toHaveLength(
      afterFirst
    );
  });

  it("returns null on a ciphertext that is not valid JSON", async () => {
    switchTo(BOB);
    const result = await decryptChannelMessage(
      ALICE.userId,
      CH,
      "not-json{",
      ALICE.deviceId
    );
    expect(result).toBeNull();
    expect(e2eeApi.fetchGroupSessions).not.toHaveBeenCalled();
  });

  it("carries file keys through a real round-trip into the payload", async () => {
    const meta = sampleMeta();
    switchTo(ALICE);
    const msg = await encryptChannelMessage(
      CH,
      ALICE.userId,
      ALICE.deviceId,
      encodePayload("hi", [meta])
    );

    switchTo(BOB);
    const payload = await decryptChannelMessage(
      ALICE.userId,
      CH,
      JSON.stringify(msg),
      ALICE.deviceId
    );

    expect(payload!.content).toBe("hi");
    expect(payload!.file_keys).toEqual([meta]);
  });

  // Two-level error surface — a deliberate design, verified by running it.

  it("decryptChannelMessage REJECTS when the sender key can never be installed", async () => {
    const msg = await aliceSends("secret");

    switchTo(BOB);
    h.fetchSuccess = false; // fetchGroupSessions returns { success: false }

    // ensureSenderKeyForDecryption swallows the failed fetch and returns, but
    // decryptGroupMessage then throws "No sender key found" — and that throw is
    // NOT caught inside decryptChannelMessage, so it propagates to the caller.
    await expect(
      decryptChannelMessage(
        ALICE.userId,
        CH,
        JSON.stringify(msg),
        ALICE.deviceId
      )
    ).rejects.toThrow(/No sender key found/i);
  });

  it("decryptChannelMessages CATCHES that same failure per-message", async () => {
    const msg = await aliceSends("secret");

    switchTo(BOB);
    h.fetchSuccess = false;

    const [out] = await decryptChannelMessages([e2eeMsg("m-fail", msg)]);

    expect(out.content).toBeNull();
    expect(h.addDecryptionError).toHaveBeenCalledTimes(1);
    expect(h.addDecryptionError).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "m-fail", channelId: CH })
    );
  });

  it("repairs a stored key that lost initialChainKey, using the sealed envelope", async () => {
    const m0 = await aliceSends("m0");
    const m1 = await aliceSends("m1");
    const m2 = await aliceSends("m2");

    // Bob processes m0 (installs the key) then m2 (advances to iteration 3).
    expect(await receiverReads(BOB, m0)).toBe("m0");
    expect(await receiverReads(BOB, m2)).toBe("m2");

    // Simulate a pre-repair stored key: strip initialChainKey. Its absence
    // breaks out-of-order rewind — exactly what ensureSenderKeyForDecryption
    // restores from the sealed distribution.
    switchTo(BOB);
    const legacy = await keyStorage.getSenderKey(
      CH,
      ALICE.userId,
      ALICE.deviceId
    );
    expect(legacy).not.toBeNull();
    expect(legacy!.iteration).toBe(3);
    legacy!.initialChainKey = undefined;
    await keyStorage.saveSenderKey(legacy!);

    // Deliver the OLD message m1 (iteration 1, behind current 3).
    expect(await receiverReads(BOB, m1)).toBe("m1");

    const repaired = await keyStorage.getSenderKey(
      CH,
      ALICE.userId,
      ALICE.deviceId
    );
    expect(repaired!.initialChainKey).toBeInstanceOf(Uint8Array);
    // Repair only restores the rewind anchor — live ratchet state is untouched.
    expect(repaired!.distributionId).toBe(m0.distributionId);
  });
});

// ──────────────────────────────────
// Bulk decrypt
// ──────────────────────────────────

describe("channelEncryption — decryptChannelMessages", () => {
  it("gates on E2EE readiness: null-outs v1, leaves v0 untouched, no fetch", async () => {
    h.initStatus = "initializing";

    const v0 = plaintextMsg("p0", "plain hello");
    const v1 = e2eeMsg("c0", "any-ciphertext");
    const out = await decryptChannelMessages([v0, v1]);

    expect(out[0]).toBe(v0);
    expect(out[1].content).toBeNull();
    expect(e2eeApi.fetchGroupSessions).not.toHaveBeenCalled();
  });

  it("bulk-decrypts a mixed batch and caches only truthy-content successes", async () => {
    const meta = sampleMeta();
    switchTo(ALICE);
    const enc = await encryptChannelMessage(
      CH,
      ALICE.userId,
      ALICE.deviceId,
      encodePayload("with file", [meta])
    );

    switchTo(BOB);
    const v0 = plaintextMsg("p0", "plain hello");
    const v1 = e2eeMsg("c0", enc);
    const out = await decryptChannelMessages([v0, v1]);

    expect(out[0]).toBe(v0);
    expect(out[1].content).toBe("with file");
    expect(out[1].e2ee_file_keys).toEqual([meta]);

    expect(h.cached).toHaveLength(1);
    expect(h.cached[0]).toEqual(
      expect.objectContaining({
        messageId: "c0",
        channelId: CH,
        dmChannelId: null,
        content: "with file",
      })
    );
  });

  it("records a decryption error for one bad message while still decrypting the rest", async () => {
    const good = await aliceSends("good one");

    // A v1 from a sender device that has no distribution on the server: Bob
    // can never install its key, so decrypt throws.
    const badCipher = JSON.stringify({
      distributionId: "ffffffffffffffffffffffffffffffff",
      iteration: 0,
      ciphertext: "AAAA",
    });

    switchTo(BOB);
    const bad = e2eeMsg("m-bad", badCipher, CAROL.userId, CAROL.deviceId);
    const goodMsg = e2eeMsg("m-good", good);

    const out = await decryptChannelMessages([bad, goodMsg]);

    expect(out[0].content).toBeNull();
    expect(out[1].content).toBe("good one");
    expect(h.addDecryptionError).toHaveBeenCalledTimes(1);
    expect(h.addDecryptionError).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "m-bad" })
    );
    expect(h.cached).toHaveLength(1);
    expect(h.cached[0]).toEqual(
      expect.objectContaining({ messageId: "m-good" })
    );
  });

  it("leaves v1 messages missing ciphertext or device id on the plaintext path", async () => {
    const noDevice = baseMessage("n0", {
      encryption_version: 1,
      ciphertext: "something",
      sender_device_id: null,
    });
    const noCipher = baseMessage("n1", {
      encryption_version: 1,
      ciphertext: null,
      sender_device_id: ALICE.deviceId,
    });

    const out = await decryptChannelMessages([noDevice, noCipher]);

    expect(out[0]).toBe(noDevice);
    expect(out[1]).toBe(noCipher);
    expect(e2eeApi.fetchGroupSessions).not.toHaveBeenCalled();
  });
});
