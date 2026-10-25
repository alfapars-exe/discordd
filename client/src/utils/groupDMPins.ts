import { getAuthSessionSnapshot } from "../api/authSessionEvents";
import { pinGroupDMMessage } from "../api/groupDM";
import { useAuthStore } from "../stores/authStore";
import { useE2EEStore } from "../stores/e2eeStore";
import { useGroupDMStore } from "../stores/groupDMStore";

export const GROUP_DM_PINS_CHANGED = "hichat:group-dm-pins-changed";
export type GroupDMPinsChangedDetail = { groupId: string; scopeKey: string };
export function notifyGroupDMPinsChanged(groupId: string, isCurrent: () => boolean = () => true): void {
  if (!isCurrent()) return;
  const scope = captureGroupDMPinScope(groupId);
  if (!scope || !scope.isCurrent() || !isCurrent()) return;
  window.dispatchEvent(new CustomEvent<GroupDMPinsChangedDetail>(GROUP_DM_PINS_CHANGED, { detail: { groupId, scopeKey: scope.key } }));
}

/** An already-loaded current membership is required; the server remains authoritative. */
export function captureGroupDMPinScope(groupId: string) {
  const session = getAuthSessionSnapshot();
  const owner = useAuthStore.getState().user?.id;
  const device = useE2EEStore.getState().localDeviceId;
  const state = useGroupDMStore.getState();
  const group = state.groups.find((entry) => entry.id === groupId);
  if (!owner || session.ownerId !== owner || !device || useE2EEStore.getState().initStatus !== "ready"
    || state.ownerId !== owner || state.authGeneration !== session.generation || !state.groupsReady
    || !group?.members.some((member) => member.id === owner)) return null;
  const epoch = group.key_epoch;
  const isCurrent = () => {
    const auth = getAuthSessionSnapshot();
    const latest = useGroupDMStore.getState();
    const crypto = useE2EEStore.getState();
    return auth.ownerId === owner && auth.generation === session.generation && useAuthStore.getState().user?.id === owner
      && crypto.localDeviceId === device && crypto.initStatus === "ready"
      && latest.ownerId === owner && latest.authGeneration === session.generation && latest.groupsReady
      && latest.groups.some((entry) => entry.id === groupId && entry.key_epoch === epoch && entry.members.some((member) => member.id === owner));
  };
  return { owner, device, group, isCurrent, key: JSON.stringify([owner, session.generation, device, groupId, epoch]) };
}

/** A pin request never receives plaintext, and stale success is not reported as current success. */
export async function pinCurrentGroupDMMessage(groupId: string, messageId: string, context?: { ownerId: string; authGeneration: number; isCurrent?: () => boolean }): Promise<boolean> {
  const scope = captureGroupDMPinScope(groupId);
  const generation = getAuthSessionSnapshot().generation;
  const current = () => !!scope && scope.isCurrent() && (!context || context.ownerId === scope.owner && context.authGeneration === generation && (!context.isCurrent || context.isCurrent()));
  if (!scope || !messageId || !current()) return false;
  try {
    const result = await pinGroupDMMessage(groupId, messageId, { expectedUserId: scope.owner, isCurrent: current });
    const confirmed = current() && result.success && result.data?.status === "pinned";
    if (confirmed) notifyGroupDMPinsChanged(groupId, current);
    return confirmed;
  } catch { return false; }
}
