import { apiClient } from "../api/client";
import { getAuthSessionSnapshot } from "../api/authSessionEvents";
import { SERVER_URL } from "../utils/constants";
import * as e2eeApi from "../api/e2ee";
import * as signalProtocol from "./signalProtocol";
import type { PreKeyBundleResponse } from "../types";

export type DMEncryptionTarget = (PreKeyBundleResponse & { roster_revision?: string }) |
  { device_id: string; established_session: true };
type Reference = { device_id: string; key_revision: string };
type Roster = { version: number; members: { user_id: string; devices: Reference[] }[] };
export type DMRosterOptions = { channelId: string; isCurrent: () => boolean };

// Only public revision receipts are retained. Never retain a prekey bundle or
// reuse a one-time prekey. Old scopes cannot authorize new-account work.
const revisions = new Map<string, string>();
const capabilities = new Map<string, { expires: number; result: Promise<boolean> }>();
const MAX_REVISION_RECEIPTS = 512;
const MAX_CAPABILITY_SCOPES = 16;

export async function deviceRosterRevision(bundle: PreKeyBundleResponse): Promise<string> {
  const encoded = new TextEncoder().encode("hichat-device-roster-v1\x00" +
    JSON.stringify([bundle.identity_key, bundle.signing_key ?? null, bundle.registration_id]));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoded));
  return [...digest].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function prepareDMDeviceRoster(
  currentUser: string, peer: string, localDevice: string, options: DMRosterOptions,
) {
  const scope = getAuthSessionSnapshot();
  const authCurrent = () => {
    const now = getAuthSessionSnapshot();
    return now.ownerId === scope.ownerId && now.generation === scope.generation;
  };
  const current = () => authCurrent() && options.isCurrent();
  const assertCurrent = () => { if (!current()) throw new Error("e2ee_account_scope_changed"); };
  assertCurrent();
  if (scope.ownerId && scope.ownerId !== currentUser) throw new Error("e2ee_account_scope_changed");
  const scopeKey = JSON.stringify([scope.ownerId, scope.generation, SERVER_URL]);
  let capability = capabilities.get(scopeKey);
  if (!capability || capability.expires <= Date.now()) {
    const result = apiClient<{ dm_device_roster_version?: number }>("/dms/send-capabilities", {
      isCurrent: authCurrent, timeoutMs: 10000, cache: "no-store",
    }).then(response => {
      if (!authCurrent()) throw new Error("e2ee_account_scope_changed");
      if (!response.success) {
        if (response.status === 404) return false;
        throw new Error("DM_CAPABILITIES_UNAVAILABLE");
      }
      const version = response.data?.dm_device_roster_version;
      if (version === undefined) return false; // Existing server, legacy protocol.
      if (version !== 1) throw new Error("DM_ROSTER_VERSION_UNSUPPORTED");
      return true;
    });
    capability = { expires: Date.now() + 60000, result };
    capabilities.set(scopeKey, capability);
    if (capabilities.size > MAX_CAPABILITY_SCOPES) capabilities.delete(capabilities.keys().next().value!);
    // A failed request must not pin a transient failure for the next send.
    void result.catch(() => { if (capabilities.get(scopeKey) === capability) capabilities.delete(scopeKey); });
  }
  const supported = await capability.result;
  assertCurrent();
  if (!supported) return null;
  const response = await apiClient<Roster>(`/dms/${options.channelId}/device-roster`, {
    isCurrent: current, timeoutMs: 10000, cache: "no-store",
  });
  assertCurrent();
  if (!response.success || !response.data) throw new Error("DM_ROSTER_UNAVAILABLE");
  const roster = response.data;
  const expected = new Set([currentUser, peer]);
  if (roster.version !== 1 || !Array.isArray(roster.members) || roster.members.length !== expected.size) {
    throw new Error("DM_ROSTER_INVALID");
  }
  const members = new Map<string, Reference[]>();
  for (const member of roster.members) {
    if (!expected.has(member.user_id) || members.has(member.user_id) || !Array.isArray(member.devices)) {
      throw new Error("DM_ROSTER_INVALID");
    }
    const seen = new Set<string>();
    for (const ref of member.devices) {
      if (typeof ref.device_id !== "string" || !ref.device_id || seen.has(ref.device_id) ||
          typeof ref.key_revision !== "string" || !/^[a-f0-9]{64}$/.test(ref.key_revision)) throw new Error("DM_ROSTER_INVALID");
      seen.add(ref.device_id);
    }
    members.set(member.user_id, member.devices);
  }
  if (!members.get(currentUser)?.some(ref => ref.device_id === localDevice)) throw new Error("DM_LOCAL_DEVICE_REVOKED");
  const key = (user: string, device: string) => JSON.stringify([scopeKey, localDevice, user, device]);
  return {
    assertCurrent,
    remember(user: string, device: string, revision: string) {
      assertCurrent();
      const id = key(user, device);
      revisions.delete(id);
      revisions.set(id, revision);
      if (revisions.size > MAX_REVISION_RECEIPTS) revisions.delete(revisions.keys().next().value!);
    },
    async targets(user: string, forceHandshake = false, excludeDevice?: string): Promise<DMEncryptionTarget[]> {
      assertCurrent();
      const refs = members.get(user)!.filter(ref => ref.device_id !== excludeDevice);
      let fetchBundles = forceHandshake;
      for (const ref of refs) {
        const session = await signalProtocol.hasSessionFor(user, ref.device_id);
        assertCurrent();
        if (!session || revisions.get(key(user, ref.device_id)) !== ref.key_revision) fetchBundles = true;
      }
      if (!refs.length) return [];
      if (!fetchBundles) return refs.map(ref => ({ device_id: ref.device_id, established_session: true }));
      const bundles = await e2eeApi.fetchPreKeyBundles(user, { isCurrent: current, timeoutMs: 10000 });
      assertCurrent();
      if (!bundles.success || !bundles.data) throw new Error("DM_PREKEY_BUNDLES_UNAVAILABLE");
      const relevant = bundles.data.filter(bundle => bundle.device_id !== excludeDevice);
      const expectedRefs = new Map(refs.map(ref => [ref.device_id, ref.key_revision]));
      if (relevant.length !== expectedRefs.size || new Set(relevant.map(bundle => bundle.device_id)).size !== relevant.length) {
        throw new Error("DM_ROSTER_CHANGED");
      }
      const targets: DMEncryptionTarget[] = [];
      for (const bundle of relevant) {
        const revision = await deviceRosterRevision(bundle);
        assertCurrent();
        if (expectedRefs.get(bundle.device_id) !== revision) throw new Error("DM_ROSTER_CHANGED");
        targets.push({ ...bundle, roster_revision: revision });
      }
      return targets;
    },
  };
}

export type DMDeviceRosterContext = NonNullable<Awaited<ReturnType<typeof prepareDMDeviceRoster>>>;
