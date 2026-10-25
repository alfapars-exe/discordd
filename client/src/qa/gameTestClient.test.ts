import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GameTestClient } from "./gameTestClient";

const f = vi.hoisted(() => ({ metadata: vi.fn(), saveRegistration: vi.fn(), registration: vi.fn(), identity: vi.fn(), generate: vi.fn(), hasSession: vi.fn(), encrypt: vi.fn(), decrypt: vi.fn(), processBundle: vi.fn(), owner: vi.fn(), generation: vi.fn(), fetch: vi.fn(), devices: [{ device_id: "peer-device" }], failSend: false }));
vi.mock("../crypto/keyStorage", () => ({ getRegistrationData: f.registration, getIdentityKeyPair: f.identity, setMetadata: f.metadata, saveRegistrationData: f.saveRegistration }));
vi.mock("../crypto/signalProtocol", () => ({ generateAllKeys: f.generate, hasSessionFor: f.hasSession, processPreKeyBundle: f.processBundle, encryptMessage: f.encrypt, decryptMessage: f.decrypt }));
vi.mock("../api/authSessionEvents", () => ({ publishAuthOwnerChange: f.owner, publishAuthGenerationChange: f.generation }));
const token = "hb_test_only_not_a_real_token";
const wire = { type: 2, header: {}, ciphertext: "opaque-encrypted-by-signal" };
beforeEach(() => {
  vi.resetAllMocks(); f.devices = [{ device_id: "peer-device" }]; f.failSend = false;
  f.registration.mockResolvedValue({ userId: "bot", deviceId: "bot-device" });
  f.identity.mockResolvedValue({ publicKey: new Uint8Array(32) });
  f.hasSession.mockResolvedValue(true); f.encrypt.mockResolvedValue(wire);
  vi.stubGlobal("fetch", f.fetch);
  f.fetch.mockImplementation(async (path: string, options: RequestInit) => {
    expect(options.credentials).toBe("omit");
    expect(options.headers).toMatchObject({ Authorization: `Bearer ${token}` });
    let data: unknown;
    if (path === "/api/users/me") data = { id: "bot", username: "game", is_bot: true };
    else if (path === "/api/devices") data = [{ device_id: "bot-device" }];
    else if (path === "/api/dms") data = { id: "dm" };
    else if (path === "/api/users/peer/devices") data = f.devices;
    else if (path === "/api/dms/dm/messages" && options.method === "POST") {
      if (f.failSend) return { ok: false, status: 403, json: async () => ({ success: false, code: "FORBIDDEN" }) };
      const body = JSON.parse(options.body as string);
      data = { id: "sent1", dm_channel_id: "dm", user_id: "bot", application_id: "bot", content: null, ...body };
    } else throw new Error(`unexpected transport ${path}`);
    return { ok: true, status: 200, json: async () => ({ success: true, data }) };
  });
});
afterEach(() => vi.unstubAllGlobals());

it("uses its bot transport and sends only Signal wire data, never the plaintext or a human refresh request", async () => {
  const client = new GameTestClient();
  await client.connect(token);
  expect(await client.send("peer", "private message")).toEqual({ id: "sent1", channel: "dm", application: "bot", encryption: 1 });
  const call = f.fetch.mock.calls.find(([path]) => path === "/api/dms/dm/messages")!;
  expect(call[1].body).not.toContain("private message");
  expect(JSON.parse(call[1].body)).toMatchObject({ encryption_version: 1, sender_device_id: "bot-device" });
  expect(f.encrypt).toHaveBeenCalledWith("peer", "peer-device", JSON.stringify({ content: "private message" }), expect.any(Function));
  expect(f.fetch.mock.calls.some(([path]) => path.includes("/auth/refresh"))).toBe(false);
  expect(f.owner).toHaveBeenLastCalledWith("bot");
});

it("refuses to fall back to plaintext when the recipient has no keys", async () => {
  f.devices = [];
  const client = new GameTestClient(); await client.connect(token);
  await expect(client.send("peer", "private message")).rejects.toThrow("no_plaintext_fallback");
  expect(f.encrypt).not.toHaveBeenCalled();
  expect(f.fetch.mock.calls.some(([path]) => path === "/api/dms/dm/messages")).toBe(false);
});

it("reports a revoked grant without automatically retrying or posting a plaintext alternative", async () => {
  f.failSend = true;
  const client = new GameTestClient(); await client.connect(token);
  await expect(client.send("peer", "private message")).rejects.toThrow("http_403:FORBIDDEN");
  expect(f.fetch.mock.calls.filter(([path]) => path === "/api/dms/dm/messages")).toHaveLength(1);
});

it("does not open bot keys after a delayed identity lookup crosses disconnect", async () => {
  let finish!: (result: unknown) => void;
  f.fetch.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  const client = new GameTestClient(); const connection = client.connect(token);
  client.disconnect();
  finish({ ok: true, status: 200, json: async () => ({ success: true, data: { id: "bot", is_bot: true } }) });
  await expect(connection).rejects.toThrow("session_changed");
  expect(f.registration).not.toHaveBeenCalled();
});

it("keeps existing device keys when the server no longer recognizes the device", async () => {
  f.fetch.mockImplementationOnce(async () => ({ ok: true, status: 200, json: async () => ({ success: true, data: { id: "bot", is_bot: true } }) }))
    .mockImplementationOnce(async () => ({ ok: true, status: 200, json: async () => ({ success: true, data: [] }) }));
  await expect(new GameTestClient().connect(token)).rejects.toThrow("keys_preserved");
  expect(f.generate).not.toHaveBeenCalled();
});

it("decrypts only its addressed peer envelope and does not consume the ratchet twice on polling", async () => {
  const fallback = f.fetch.getMockImplementation()!;
  f.decrypt.mockResolvedValue(JSON.stringify({ content: "peer reply" }));
  f.fetch.mockImplementation(async (path: string, options: RequestInit) => {
    if (path !== "/api/dms/dm/messages?limit=100") return fallback(path, options);
    return { ok: true, status: 200, json: async () => ({ success: true, data: { messages: [{ id: "reply1", user_id: "peer", dm_channel_id: "dm", encryption_version: 1, ciphertext: JSON.stringify([
      { sender_device_id: "peer-device", recipient_device_id: "other-device", ciphertext: "not-our-envelope" },
      { sender_device_id: "peer-device", recipient_device_id: "bot-device", ciphertext: JSON.stringify(wire) },
    ]) }] } }) };
  });
  const client = new GameTestClient(); await client.connect(token);
  expect(await client.poll("peer")).toEqual([{ id: "reply1", content: "peer reply" }]);
  expect(await client.poll("peer")).toEqual([]);
  expect(f.decrypt).toHaveBeenCalledExactlyOnceWith("peer", "peer-device", wire, expect.any(Function));
});

it("does not establish a session without a signed recipient key", async () => {
  f.hasSession.mockResolvedValue(false);
  const fallback = f.fetch.getMockImplementation()!;
  f.fetch.mockImplementation(async (path: string, options: RequestInit) => path === "/api/users/peer/prekey-bundles"
    ? { ok: true, status: 200, json: async () => ({ success: true, data: [{ device_id: "peer-device", signing_key: null }] }) }
    : fallback(path, options));
  const client = new GameTestClient(); await client.connect(token);
  await expect(client.send("peer", "private message")).rejects.toThrow("recipient_signed_keys_missing");
  expect(f.processBundle).not.toHaveBeenCalled(); expect(f.encrypt).not.toHaveBeenCalled();
});

it("registers only public key material for a fresh bot device and never persists its bearer credential", async () => {
  f.registration.mockResolvedValue(undefined); f.identity.mockResolvedValue(undefined);
  f.generate.mockResolvedValue({ identityPublicKey: "public-identity", signingPublicKey: "public-signing", signedPreKey: { id: 1, publicKey: "public-signed-prekey", signature: "public-signature" }, oneTimePreKeys: [{ id: 1, publicKey: "public-onetime-prekey" }], registrationId: 42 });
  const fallback = f.fetch.getMockImplementation()!;
  f.fetch.mockImplementation(async (path: string, options: RequestInit) => path === "/api/devices" && options.method === "POST"
    ? { ok: true, status: 200, json: async () => ({ success: true, data: { device_id: JSON.parse(options.body as string).device_id } }) }
    : fallback(path, options));
  const client = new GameTestClient(); const connected = await client.connect(token);
  const registration = JSON.parse(f.fetch.mock.calls.find(([path, options]) => path === "/api/devices" && options.method === "POST")![1].body);
  expect(registration).toMatchObject({ identity_key: "public-identity", signing_key: "public-signing", signed_prekey: "public-signed-prekey", signed_prekey_signature: "public-signature", registration_id: 42, one_time_prekeys: [{ prekey_id: 1, public_key: "public-onetime-prekey" }] });
  expect(f.saveRegistration).toHaveBeenCalledWith(expect.objectContaining({ userId: "bot", deviceId: connected.device, registrationId: 42 }));
  expect(JSON.stringify(f.metadata.mock.calls)).not.toContain(token);
  expect(JSON.stringify(f.saveRegistration.mock.calls)).not.toContain(token);
});

it("does not overwrite recoverable partial key material", async () => {
  f.registration.mockResolvedValue(undefined);
  await expect(new GameTestClient().connect(token)).rejects.toThrow("partial_device_keys_preserved");
  expect(f.generate).not.toHaveBeenCalled(); expect(f.saveRegistration).not.toHaveBeenCalled();
});
