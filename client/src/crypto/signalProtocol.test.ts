/**
 * signalProtocol tests — DM (1-1) X3DH + Double Ratchet layer.
 *
 * These exercise the REAL crypto path: X25519 ECDH, Ed25519 prekey-bundle
 * signatures, HKDF-SHA-256 root/chain derivation, HMAC-SHA-256 chain ratchet,
 * and AES-256-GCM message encryption via WebCrypto. Only the storage layer
 * (keyStorage) is mocked — @noble/* and crypto.subtle stay REAL (jsdom + Node
 * webcrypto provide them).
 *
 * Honesty invariant (mirrors senderKeyProtocol.test.ts): Alice's and Bob's
 * sessions MUST live in separate stores. A single shared session store would
 * let the "receiver" read the sender's already-advanced live keys and fake a
 * round-trip without ever performing the real X3DH/ratchet derivation. So we
 * keep TWO isolated in-memory stores (alice / bob) plus a temp store (bob2 for
 * the identity-change case) and switch the active pointer between encrypt and
 * decrypt phases: encrypt runs with active=alice, decrypt with active=bob.
 *
 * The prekey bundle is bridged by hand: Bob's public keys come from the REAL
 * generateAllKeys() (active=bob) and are mapped into processPreKeyBundle's
 * shape, so Ed25519 signature verification follows the genuine code path.
 *
 * Module-global state note: signalProtocol keeps a process-wide
 * pendingIdentityChanges queue and identityChangeListeners array. beforeEach
 * drains the queue; afterEach removes every listener subscribed in a test so
 * state never leaks across cases.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type {
  StoredIdentityKeyPair,
  StoredSigningKeyPair,
  StoredSignedPreKey,
  StoredPreKey,
  StoredSession,
  TrustedIdentity,
  RegistrationData,
  SignalWireMessage,
} from "./types";
import { SignalMessageType, MAX_SKIP } from "./types";

// ──────────────────────────────────
// Two isolated stores + active pointer (hoisted for the vi.mock factory)
// ──────────────────────────────────

type Store = {
  identity: StoredIdentityKeyPair | null;
  signing: StoredSigningKeyPair | null;
  registration: RegistrationData | null;
  signedPreKeys: Map<number, StoredSignedPreKey>;
  preKeys: Map<number, StoredPreKey>;
  sessions: Map<string, StoredSession>;
  trusted: Map<string, TrustedIdentity>;
  meta: Map<string, unknown>;
};

const h = vi.hoisted(() => {
  const makeStore = (): Store => ({
    identity: null,
    signing: null,
    registration: null,
    signedPreKeys: new Map(),
    preKeys: new Map(),
    sessions: new Map(),
    trusted: new Map(),
    meta: new Map(),
  });
  const alice = makeStore();
  const bob = makeStore();
  const bob2 = makeStore();
  return { alice, bob, bob2, active: alice };
});

const compositeKey = (userId: string, deviceId: string): string =>
  `${userId}:${deviceId}`;

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
  setMetadata: vi.fn(async (key: string, value: unknown) => {
    h.active.meta.set(key, value);
  }),
  getMetadata: vi.fn(async (key: string) => h.active.meta.get(key) ?? null),
}));

import {
  generateAllKeys,
  processPreKeyBundle,
  encryptMessage,
  decryptMessage,
  drainIdentityKeyChanges,
  onIdentityKeyChange,
  toBase64,
  fromBase64,
} from "./signalProtocol";

// ──────────────────────────────────
// Fixtures + helpers
// ──────────────────────────────────

const ALICE = { userId: "alice-user", deviceId: "alice-device" };
const BOB = { userId: "bob-user", deviceId: "bob-device" };

type GeneratedKeys = Awaited<ReturnType<typeof generateAllKeys>>;
type PreKeyBundle = Parameters<typeof processPreKeyBundle>[2];

/**
 * Map a generateAllKeys() result into a processPreKeyBundle bundle. The field
 * renames here are the exact server<->client shape mismatch the app bridges;
 * keeping the mapping honest is what makes Ed25519 verification run for real.
 */
function bundleFromKeys(keys: GeneratedKeys, withOtp: boolean): PreKeyBundle {
  const base: PreKeyBundle = {
    identityKey: keys.identityPublicKey,
    signingKey: keys.signingPublicKey,
    signedPrekeyId: keys.signedPreKey.id,
    signedPrekey: keys.signedPreKey.publicKey,
    signedPrekeySignature: keys.signedPreKey.signature,
    registrationId: keys.registrationId,
  };
  if (!withOtp) return base;
  return {
    ...base,
    oneTimePrekeyId: keys.oneTimePreKeys[0].id,
    oneTimePrekey: keys.oneTimePreKeys[0].publicKey,
  };
}

function resetStore(s: Store): void {
  s.identity = null;
  s.signing = null;
  s.registration = null;
  s.signedPreKeys.clear();
  s.preKeys.clear();
  s.sessions.clear();
  s.trusted.clear();
  s.meta.clear();
}

/** Listeners subscribed within a test, torn down in afterEach. */
const activeUnsubs: Array<() => void> = [];
function trackUnsub(unsub: () => void): void {
  activeUnsubs.push(unsub);
}

/**
 * Run the full X3DH handshake: Bob publishes a real bundle, Alice consumes it
 * and initializes her sending session. Leaves Alice with a pending PreKey and
 * Bob with the private keys needed to answer the first PreKey message.
 */
async function establishSession(
  opts: { withOtp?: boolean } = {}
): Promise<void> {
  h.active = h.bob;
  const bobKeys = await generateAllKeys();
  h.active = h.alice;
  await generateAllKeys();
  await processPreKeyBundle(
    BOB.userId,
    BOB.deviceId,
    bundleFromKeys(bobKeys, opts.withOtp ?? true)
  );
}

async function aliceEncrypt(text: string): Promise<SignalWireMessage> {
  h.active = h.alice;
  return encryptMessage(BOB.userId, BOB.deviceId, text);
}

async function bobDecrypt(wire: SignalWireMessage): Promise<string> {
  h.active = h.bob;
  return decryptMessage(ALICE.userId, ALICE.deviceId, wire);
}

async function bobEncrypt(text: string): Promise<SignalWireMessage> {
  h.active = h.bob;
  return encryptMessage(ALICE.userId, ALICE.deviceId, text);
}

async function aliceDecrypt(wire: SignalWireMessage): Promise<string> {
  h.active = h.alice;
  return decryptMessage(BOB.userId, BOB.deviceId, wire);
}

beforeEach(() => {
  vi.clearAllMocks();
  // Drain the module-global pending-changes queue so leakage from a prior test
  // can't be mistaken for a change detected here.
  drainIdentityKeyChanges();
  resetStore(h.alice);
  resetStore(h.bob);
  resetStore(h.bob2);
  h.active = h.alice;
});

afterEach(() => {
  for (const unsub of activeUnsubs.splice(0)) unsub();
});

// ──────────────────────────────────
// Sub-slice A — X3DH handshake + core ratchet
// ──────────────────────────────────

describe("signalProtocol — X3DH handshake + core ratchet", () => {
  it("derives a mutual secret via the 4-DH (with one-time prekey) path", async () => {
    await establishSession({ withOtp: true });

    const wire = await aliceEncrypt("hello X3DH");
    // First message on a fresh session is a PreKey message carrying X3DH info.
    expect(wire.type).toBe(SignalMessageType.PreKey);
    expect(wire.preKeyInfo).toBeDefined();
    expect(wire.preKeyInfo?.oneTimePrekeyId).toBeDefined();

    expect(await bobDecrypt(wire)).toBe("hello X3DH");
  });

  it("derives a mutual secret via the 3-DH (no one-time prekey) path", async () => {
    await establishSession({ withOtp: false });

    const wire = await aliceEncrypt("no otp path");
    expect(wire.type).toBe(SignalMessageType.PreKey);
    // Without an OTP the X3DH info must not claim a one-time prekey id.
    expect(wire.preKeyInfo?.oneTimePrekeyId).toBeUndefined();

    expect(await bobDecrypt(wire)).toBe("no otp path");
  });

  it("advances the sending chain: first message PreKey, rest Whisper, in order", async () => {
    await establishSession();

    const texts = ["m0", "m1", "m2"];
    const wires: SignalWireMessage[] = [];
    for (const t of texts) wires.push(await aliceEncrypt(t));

    expect(wires[0].type).toBe(SignalMessageType.PreKey);
    expect(wires[1].type).toBe(SignalMessageType.Whisper);
    expect(wires[2].type).toBe(SignalMessageType.Whisper);
    // messageNumber is the chain position; it increments monotonically.
    expect(wires[0].header.messageNumber).toBe(0);
    expect(wires[1].header.messageNumber).toBe(1);
    expect(wires[2].header.messageNumber).toBe(2);

    for (let i = 0; i < texts.length; i++) {
      expect(await bobDecrypt(wires[i])).toBe(texts[i]);
    }
  });

  it("rejects a prekey bundle whose signed-prekey signature is corrupted", async () => {
    h.active = h.bob;
    const bobKeys = await generateAllKeys();
    h.active = h.alice;
    await generateAllKeys();

    const bundle = bundleFromKeys(bobKeys, true);
    // Flip a byte of the Ed25519 signature; the key material is otherwise
    // authentic, so verification must fail closed rather than silently accept.
    const sig = fromBase64(bundle.signedPrekeySignature);
    sig[0] = sig[0] ^ 0xff;
    const badBundle: PreKeyBundle = {
      ...bundle,
      signedPrekeySignature: toBase64(sig),
    };

    await expect(
      processPreKeyBundle(BOB.userId, BOB.deviceId, badBundle)
    ).rejects.toThrow(/signature verification failed/i);
  });

  it("refuses to encrypt when no session exists for the peer", async () => {
    h.active = h.alice;
    await generateAllKeys(); // identity exists, but no session with BOB
    await expect(aliceEncrypt("nope")).rejects.toThrow(/No session found/i);
  });

  it("refuses to process a bundle when the local identity is missing", async () => {
    h.active = h.bob;
    const bobKeys = await generateAllKeys();
    // Alice store is empty (reset in beforeEach, no generateAllKeys) → the
    // identity guard must trip before any DH work.
    h.active = h.alice;
    await expect(
      processPreKeyBundle(BOB.userId, BOB.deviceId, bundleFromKeys(bobKeys, true))
    ).rejects.toThrow(/Identity key pair not found/i);
  });
});

// ──────────────────────────────────
// Sub-slice B — bidirectional ratchet + adversarial
// ──────────────────────────────────

describe("signalProtocol — bidirectional ratchet + adversarial", () => {
  it("performs a bidirectional DH ratchet across a reply and back", async () => {
    await establishSession();

    // Alice → Bob (opens the session).
    const a0 = await aliceEncrypt("alice-1");
    expect(await bobDecrypt(a0)).toBe("alice-1");

    // Bob → Alice: Bob's reply carries a NEW ratchet key, so Alice's decrypt
    // must take a DH ratchet step to derive the receiving chain.
    const b0 = await bobEncrypt("bob-1");
    expect(b0.type).toBe(SignalMessageType.Whisper);
    expect(b0.header.ratchetKey).not.toBe(a0.header.ratchetKey);
    expect(await aliceDecrypt(b0)).toBe("bob-1");

    // Alice → Bob again: Alice ratcheted while decrypting b0, so this message
    // carries a fresh ratchet key that drives a DH ratchet step on Bob.
    const a1 = await aliceEncrypt("alice-2");
    expect(a1.header.ratchetKey).not.toBe(a0.header.ratchetKey);
    expect(await bobDecrypt(a1)).toBe("alice-2");
  });

  it("decrypts out-of-order deliveries via the skipped-key store", async () => {
    await establishSession();

    const texts = ["ooo-0", "ooo-1", "ooo-2"];
    const wires: SignalWireMessage[] = [];
    for (const t of texts) wires.push(await aliceEncrypt(t));

    // Deliver 0, then 2 (which stashes the key for 1), then 1 from the store.
    expect(await bobDecrypt(wires[0])).toBe("ooo-0");
    expect(await bobDecrypt(wires[2])).toBe("ooo-2");
    expect(await bobDecrypt(wires[1])).toBe("ooo-1");
  });

  it("rejects a forged header that would skip more than MAX_SKIP messages", async () => {
    await establishSession();

    const m0 = await aliceEncrypt("skip-0");
    // A genuine Whisper whose ratchetKey matches Bob's current receiving key,
    // so cloning its header stays on the no-DH-ratchet branch.
    const m1 = await aliceEncrypt("skip-1");
    expect(await bobDecrypt(m0)).toBe("skip-0"); // Bob receiveMessageNumber → 1

    // Forge a header claiming a chain position 1 + MAX_SKIP + 1 ahead. The DoS
    // guard must reject before deriving that many message keys. We keep the
    // ratchetKey identical so the DH ratchet branch (which would reset the
    // counter) is deliberately not taken.
    const forged: SignalWireMessage = {
      ...m1,
      header: { ...m1.header, messageNumber: 1 + MAX_SKIP + 1 },
    };
    await expect(bobDecrypt(forged)).rejects.toThrow(/Too many skipped/i);
  });

  it("rejects a message whose ciphertext bytes were tampered", async () => {
    await establishSession();

    const m0 = await aliceEncrypt("tamper-0");
    expect(await bobDecrypt(m0)).toBe("tamper-0"); // establish + advance chain
    const m1 = await aliceEncrypt("tamper-1");

    // Wire ciphertext layout: nonce(12) || ciphertext || tag(16). Flip a byte
    // AFTER the nonce so the nonce stays valid and the failure is provably
    // AES-GCM authentication over the body, not a corrupted nonce.
    const raw = fromBase64(m1.ciphertext);
    expect(raw.length).toBeGreaterThan(12);
    raw[12] = raw[12] ^ 0xff;
    const tampered: SignalWireMessage = { ...m1, ciphertext: toBase64(raw) };

    await expect(bobDecrypt(tampered)).rejects.toThrow();
  });

  it("rejects a duplicate delivery of an already-consumed Whisper message", async () => {
    await establishSession();

    const m0 = await aliceEncrypt("dup-0"); // PreKey
    expect(await bobDecrypt(m0)).toBe("dup-0");
    const m1 = await aliceEncrypt("dup-1"); // Whisper
    expect(await bobDecrypt(m1)).toBe("dup-1"); // consumes chain position 1

    // Re-delivering the same Whisper is NOT caught by an explicit replay check:
    // the receiving chain has ratcheted past position 1, so deriveMessageKey
    // now yields the wrong key and AES-GCM authentication fails on the
    // duplicate delivery. (A PreKey message would re-establish and decrypt
    // again, which is why this case uses a Whisper.)
    await expect(bobDecrypt(m1)).rejects.toThrow();
  });

  it("detects an identity-key change for the same device tuple (safety number)", async () => {
    let fireCount = 0;
    trackUnsub(
      onIdentityKeyChange(() => {
        fireCount++;
      })
    );

    // First contact: trust identity #1 for the BOB tuple. First use must not
    // record a change.
    h.active = h.bob;
    const bob1 = await generateAllKeys();
    h.active = h.alice;
    await generateAllKeys();
    await processPreKeyBundle(
      BOB.userId,
      BOB.deviceId,
      bundleFromKeys(bob1, true)
    );
    expect(drainIdentityKeyChanges()).toHaveLength(0);
    expect(fireCount).toBe(0);

    // Second fetch: SAME (userId, deviceId) but a DIFFERENT identity key,
    // generated in an isolated store — the shape of a hostile-server MITM swap.
    h.active = h.bob2;
    const bob2 = await generateAllKeys();
    h.active = h.alice;
    await processPreKeyBundle(
      BOB.userId,
      BOB.deviceId,
      bundleFromKeys(bob2, true)
    );

    const changes = drainIdentityKeyChanges();
    expect(changes).toHaveLength(1);
    expect(changes[0].userId).toBe(BOB.userId);
    expect(changes[0].deviceId).toBe(BOB.deviceId);
    expect(changes[0].previousKey).toBe(bob1.identityPublicKey);
    expect(changes[0].newKey).toBe(bob2.identityPublicKey);
    expect(fireCount).toBe(1);
  });
});
