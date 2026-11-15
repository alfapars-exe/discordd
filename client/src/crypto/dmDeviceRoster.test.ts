import { beforeEach, expect, it, vi } from "vitest";
import { getAuthSessionSnapshot, publishAuthGenerationChange, publishAuthOwnerChange } from "../api/authSessionEvents";
import { apiClient } from "../api/client";
import * as e2eeApi from "../api/e2ee";
import { deviceRosterRevision, prepareDMDeviceRoster } from "./dmDeviceRoster";
import { encryptDMMessage, encryptGroupDMMessage, markSelfFanoutNeedsReset } from "./dmEncryption";
import * as signalProtocol from "./signalProtocol";
import { useE2EEStore } from "../stores/e2eeStore";
import type { PreKeyBundleResponse } from "../types";

const h = vi.hoisted(() => ({
  sessions: new Set<string>(), pins: new Map<string, string>(), metadata: new Map<string, unknown>(), alerts: vi.fn(), peerDevices: ["peer-device"], ownDevices: ["local"],
  identity: "aGVsbG8=", denied: false, version: 1 as number | undefined,
  pause: null as Promise<void> | null, groupMembers: ["me", "peer", "third"], groupEpoch: 7, groupVersion: 1 as number | undefined,
}));
function bundle(device: string): PreKeyBundleResponse {
  return { device_id: device, identity_key: h.identity, signing_key: "c2lnbg==", registration_id: 7,
    signed_prekey_id: 1, signed_prekey: "prekey", signed_prekey_signature: "signature",
    one_time_prekey_id: 1, one_time_prekey: "single-use" };
}
vi.mock("./signalProtocol", () => ({
  hasSessionFor: vi.fn(async (user: string, device: string) => h.sessions.has(`${user}:${device}`)),
  fromBase64: (value: string) => Uint8Array.from(atob(value), char => char.charCodeAt(0)),
  processPreKeyBundle: vi.fn(async (user: string, device: string, bundle: { identityKey: string }) => {
    h.sessions.add(`${user}:${device}`); h.pins.set(`${user}:${device}`, bundle.identityKey);
  }),
  encryptMessage: vi.fn(async (user: string, device: string, content: string) => {
    if (!h.sessions.has(`${user}:${device}`)) throw new Error("Session missing");
    return { type: 1, header: {}, ciphertext: content };
  }),
}));
vi.mock("./keyStorage", () => ({
  getMetadata: vi.fn(async (key: string) => h.metadata.get(key)),
  setMetadata: vi.fn(async (key: string, value: unknown) => { h.metadata.set(key, value); }),
  deleteSession: vi.fn(async (user: string, device: string) => { h.sessions.delete(`${user}:${device}`); }),
  getTrustedDeviceIdsForUser: vi.fn(async (user: string) => new Set([...h.pins.keys()].filter(key => key.startsWith(`${user}:`)).map(key => key.slice(user.length + 1)))),
  getTrustedIdentity: vi.fn(async (user: string, device: string) => {
    const identity = h.pins.get(`${user}:${device}`);
    return identity ? { identityKey: Uint8Array.from(atob(identity), char => char.charCodeAt(0)) } : null;
  }),
}));
vi.mock("./deviceManager", () => ({}));
vi.mock("../stores/e2eeStore", () => ({ useE2EEStore: { getState: () => ({
  localDeviceId: "local", markPeerTrustAlert: h.alerts, markIncompatibleDevice: vi.fn(),
}) } }));
vi.mock("../stores/composerDraftStore", () => ({ useComposerDraftStore: { getState: () => ({ generation: 0 }) } }));
vi.mock("../api/e2ee", () => ({ fetchPreKeyBundles: vi.fn(async (user: string) => ({
  success: true, data: (user === "me" ? h.ownDevices : user === "third" ? ["third-device"] : h.peerDevices).map(bundle),
})) }));
vi.mock("../api/client", () => ({ apiClient: vi.fn(async (endpoint: string) => {
  if (endpoint.endsWith("send-capabilities")) return { success: true, data: { dm_device_roster_version: h.version, group_dm_device_roster_version: h.groupVersion } };
  if (h.pause) await h.pause;
  if (h.denied) return { success: false, status: 403 };
  const members = await Promise.all((endpoint.includes("group-dms") ? h.groupMembers : ["me", "peer"]).map(async user => ({ user_id: user,
    devices: await Promise.all((user === "me" ? h.ownDevices : user === "third" ? ["third-device"] : h.peerDevices).map(async device => ({
      device_id: device, key_revision: await deviceRosterRevision(bundle(device)),
    }))),
  })));
  return { success: true, data: { version: 1, members, ...(endpoint.includes("group-dms") ? { key_epoch: h.groupEpoch } : {}) } };
}) }));

beforeEach(() => {
  vi.clearAllMocks();
  publishAuthOwnerChange("me");
  publishAuthGenerationChange(getAuthSessionSnapshot().generation + 1);
  h.sessions.clear(); h.pins.clear(); h.metadata.clear(); h.peerDevices = ["peer-device"]; h.ownDevices = ["local"];
  h.groupMembers = ["me", "peer", "third"]; h.groupEpoch = 7; h.groupVersion = 1;
  h.identity = "aGVsbG8="; h.denied = false; h.version = 1; h.pause = null;
});
const prepare = (isCurrent = () => true) => prepareDMDeviceRoster("me", "peer", "local", { channelId: "dm", isCurrent });

it("matches the independent Go/Python canonical revision fixture", async () => {
  expect(await deviceRosterRevision(bundle("peer-device"))).toBe("2d51906b5a2c93b4dc81345646ba830e4685675bc2a03ba52d0858f5a6983c73");
});

it("reads 26 fresh rosters while fetching bundles only for the initial session", async () => {
  for (let index = 0; index < 26; index++) {
    const context = await prepare();
    expect(context).not.toBeNull();
    const targets = await context!.targets("peer");
    if (index === 0) {
      const target = targets[0];
      expect("roster_revision" in target).toBe(true);
      if (!("roster_revision" in target) || !target.roster_revision) throw new Error("Expected fresh bundle");
      h.sessions.add("peer:peer-device");
      context!.remember("peer", target.device_id, target.roster_revision);
    } else expect(targets).toEqual([{ device_id: "peer-device", established_session: true }]);
    expect(await context!.targets("me", false, "local")).toEqual([]);
  }
  expect(e2eeApi.fetchPreKeyBundles).toHaveBeenCalledTimes(1);
  const calls = vi.mocked(apiClient).mock.calls;
  expect(calls.filter(([endpoint]) => endpoint.endsWith("device-roster"))).toHaveLength(26);
  expect(calls.filter(([endpoint]) => endpoint.endsWith("send-capabilities"))).toHaveLength(1);
  for (const [, options] of calls) expect(options?.cache).toBe("no-store");
});

it("does not reuse a removed device from an earlier roster", async () => {
  const first = await prepare();
  const targets = await first!.targets("peer");
  const target = targets[0];
  if (!("roster_revision" in target) || !target.roster_revision) throw new Error("Expected bundle");
  h.sessions.add("peer:peer-device"); first!.remember("peer", target.device_id, target.roster_revision);
  h.peerDevices = [];
  expect(await (await prepare())!.targets("peer")).toEqual([]);
  expect(e2eeApi.fetchPreKeyBundles).toHaveBeenCalledTimes(1);
});

it("does not fall back to cached authorization after access is denied", async () => {
  await prepare(); h.denied = true;
  await expect(prepare()).rejects.toThrow("DM_ROSTER_UNAVAILABLE");
  expect(e2eeApi.fetchPreKeyBundles).not.toHaveBeenCalled();
});

it("rejects a revoked local device before any handshake", async () => {
  h.ownDevices = [];
  await expect(prepare()).rejects.toThrow("DM_LOCAL_DEVICE_REVOKED");
  expect(e2eeApi.fetchPreKeyBundles).not.toHaveBeenCalled();
});

it("retains the legacy path only for a server without the new capability", async () => {
  h.version = undefined;
  expect(await prepare()).toBeNull();
  expect(vi.mocked(apiClient).mock.calls).toHaveLength(1);
});

it("rejects an account switch while a fresh roster is pending", async () => {
  let release!: () => void;
  h.pause = new Promise<void>(resolve => { release = resolve; });
  const pending = prepare();
  await vi.waitFor(() => expect(vi.mocked(apiClient).mock.calls.some(([path]) => path.endsWith("device-roster"))).toBe(true));
  publishAuthOwnerChange("another-account"); release();
  await expect(pending).rejects.toThrow("e2ee_account_scope_changed");
  expect(e2eeApi.fetchPreKeyBundles).not.toHaveBeenCalled();
});

it("checks caller ownership again before planning a handshake", async () => {
  let current = true;
  const context = await prepare(() => current);
  current = false;
  await expect(context!.targets("peer")).rejects.toThrow("e2ee_account_scope_changed");
  expect(e2eeApi.fetchPreKeyBundles).not.toHaveBeenCalled();
});

const encrypt = (content = "message") => encryptDMMessage("me", "peer", "local", content, { channelId: "dm", isCurrent: () => true });

it("encrypts 26 messages without repeatedly consuming prekey bundles", async () => {
  for (let index = 0; index < 26; index++) {
    const envelopes = await encrypt(`message ${index}`);
    expect(envelopes.map(envelope => envelope.recipient_device_id)).toEqual(["peer-device"]);
  }
  expect(e2eeApi.fetchPreKeyBundles).toHaveBeenCalledTimes(1);
  expect(signalProtocol.processPreKeyBundle).toHaveBeenCalledTimes(1);
  expect(signalProtocol.encryptMessage).toHaveBeenCalledTimes(26);
});

it("uses a fresh recipient roster for additions and removals while preserving trust alerts", async () => {
  await encrypt();
  h.peerDevices = ["peer-device", "added-device"];
  expect((await encrypt()).map(envelope => envelope.recipient_device_id)).toEqual(["peer-device", "added-device"]);
  expect(useE2EEStore.getState().markPeerTrustAlert).toHaveBeenCalledWith(expect.objectContaining({
    userId: "peer", deviceId: "added-device", kind: "new_device",
  }));
  h.peerDevices = ["added-device"];
  expect((await encrypt()).map(envelope => envelope.recipient_device_id)).toEqual(["added-device"]);
  expect(e2eeApi.fetchPreKeyBundles).toHaveBeenCalledTimes(2);
});

it("does not downgrade a previously pinned recipient after all their devices disappear", async () => {
  await encrypt(); h.peerDevices = [];
  await expect(encrypt()).rejects.toThrow("DM_RECIPIENT_DEVICES_REVOKED");
  expect(signalProtocol.encryptMessage).toHaveBeenCalledTimes(1);
});

it("fetches a new self bundle for an explicit reset and then resumes session reuse", async () => {
  h.ownDevices = ["local", "sibling"];
  await encrypt();
  await markSelfFanoutNeedsReset();
  await encrypt(); await encrypt();
  expect(vi.mocked(signalProtocol.processPreKeyBundle).mock.calls.filter(([user]) => user === "me")).toHaveLength(2);
  expect(vi.mocked(e2eeApi.fetchPreKeyBundles).mock.calls.filter(([user]) => user === "me")).toHaveLength(2);
  expect(h.metadata.get("self_fanout_reset")).toBe(false);
});

it("re-establishes an identity-changed session through the verified prekey path", async () => {
  await encrypt(); h.identity = "bmV3LWlkZW50aXR5";
  await encrypt();
  expect(signalProtocol.processPreKeyBundle).toHaveBeenCalledTimes(2);
  expect(e2eeApi.fetchPreKeyBundles).toHaveBeenCalledTimes(2);
});

it("rejects unsupported declared roster versions instead of downgrading", async () => {
  h.version = 2;
  await expect(prepare()).rejects.toThrow("DM_ROSTER_VERSION_UNSUPPORTED");
  expect(e2eeApi.fetchPreKeyBundles).not.toHaveBeenCalled();
});

it("rejects duplicate device references before consuming any prekeys", async () => {
  h.peerDevices = ["peer-device", "peer-device"];
  await expect(prepare()).rejects.toThrow("DM_ROSTER_INVALID");
  expect(e2eeApi.fetchPreKeyBundles).not.toHaveBeenCalled();
});

it("rejects a bundle that no longer matches the fresh roster", async () => {
  const context = await prepare();
  vi.mocked(e2eeApi.fetchPreKeyBundles).mockResolvedValueOnce({ success: true, data: [{ ...bundle("peer-device"), identity_key: "Y2hhbmdlZA==" }] });
  await expect(context!.targets("peer")).rejects.toThrow("DM_ROSTER_CHANGED");
  expect(signalProtocol.processPreKeyBundle).not.toHaveBeenCalled();
});

it("does not reuse a cached bundle if an established session disappears", async () => {
  await encrypt();
  vi.mocked(signalProtocol.encryptMessage).mockImplementationOnce(async () => {
    h.sessions.delete("peer:peer-device"); throw new Error("Session missing");
  });
  await expect(encrypt()).rejects.toThrow("Session missing");
  expect(signalProtocol.processPreKeyBundle).toHaveBeenCalledTimes(1);
  await encrypt();
  expect(e2eeApi.fetchPreKeyBundles).toHaveBeenCalledTimes(2);
  expect(signalProtocol.processPreKeyBundle).toHaveBeenCalledTimes(2);
});

const groupOptions = () => ({ groupId: "group", keyEpoch: 7, isCurrent: () => true });
it("uses 26 fresh group rosters and one initial bundle fetch per peer", async () => {
  for (let i = 0; i < 26; i++) {
    const envelopes = await encryptGroupDMMessage("me", ["me", "peer", "third"], "local", "message", groupOptions());
    expect(envelopes.map(item => item.recipient_device_id)).toEqual(["peer-device", "third-device"]);
  }
  expect(e2eeApi.fetchPreKeyBundles).toHaveBeenCalledTimes(2);
  expect(vi.mocked(e2eeApi.fetchPreKeyBundles).mock.calls.map(([user]) => user)).toEqual(["peer", "third"]);
  expect(signalProtocol.processPreKeyBundle).toHaveBeenCalledTimes(2);
  expect(signalProtocol.encryptMessage).toHaveBeenCalledTimes(52);
  expect(vi.mocked(apiClient).mock.calls.filter(([path]) => path === "/group-dms/group/device-roster")).toHaveLength(26);
});
it.each([
  ["changed epoch", () => { h.groupEpoch = 8; }],
  ["removed member", () => { h.groupMembers = ["me", "peer"]; }],
  ["added member", () => { h.groupMembers.push("fourth"); }],
  ["duplicate member", () => { h.groupMembers = ["me", "peer", "peer"]; }],
  ["denied membership", () => { h.denied = true; }],
] as const)("rejects %s before encrypting to a stale group snapshot", async (_name, change) => {
  change();
  await expect(encryptGroupDMMessage("me", ["me", "peer", "third"], "local", "message", groupOptions())).rejects.toThrow();
  expect(signalProtocol.encryptMessage).not.toHaveBeenCalled();
  expect(e2eeApi.fetchPreKeyBundles).not.toHaveBeenCalled();
});
it("uses legacy group encryption only when group roster capability is absent", async () => {
  h.groupVersion = undefined;
  await encryptGroupDMMessage("me", ["me", "peer", "third"], "local", "message", groupOptions());
  expect(e2eeApi.fetchPreKeyBundles).toHaveBeenCalledTimes(3);
  expect(vi.mocked(apiClient).mock.calls.filter(([path]) => path.endsWith("device-roster"))).toHaveLength(0);
});
it("rejects an account switch during a pending group roster read", async () => {
  let release!: () => void;
  h.pause = new Promise<void>(resolve => { release = resolve; });
  const pending = encryptGroupDMMessage("me", ["me", "peer", "third"], "local", "message", groupOptions());
  const result = expect(pending).rejects.toThrow("e2ee_account_scope_changed");
  await vi.waitFor(() => expect(vi.mocked(apiClient).mock.calls.some(([path]) => path === "/group-dms/group/device-roster")).toBe(true));
  publishAuthOwnerChange("different-account"); release();
  await result;
  expect(signalProtocol.encryptMessage).not.toHaveBeenCalled();
});

it("fails closed on an explicitly unsupported group roster protocol", async () => {
  h.groupVersion = 2;
  await expect(encryptGroupDMMessage("me", ["me", "peer", "third"], "local", "message", groupOptions())).rejects.toThrow("DM_ROSTER_VERSION_UNSUPPORTED");
  expect(e2eeApi.fetchPreKeyBundles).not.toHaveBeenCalled();
});
it("excludes a revoked peer device on the next group send", async () => {
  h.peerDevices = ["peer-device", "revoked-device"];
  await encryptGroupDMMessage("me", ["me", "peer", "third"], "local", "message", groupOptions());
  h.peerDevices = ["peer-device"];
  const envelopes = await encryptGroupDMMessage("me", ["me", "peer", "third"], "local", "message", groupOptions());
  expect(envelopes.map(item => item.recipient_device_id)).toEqual(["peer-device", "third-device"]);
  expect(e2eeApi.fetchPreKeyBundles).toHaveBeenCalledTimes(2);
});
