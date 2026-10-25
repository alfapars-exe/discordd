import { getAuthSessionSnapshot } from "../api/authSessionEvents";
import { listGroupDMs } from "../api/groupDM";
import { useAuthStore } from "../stores/authStore";
import { useGroupDMStore } from "../stores/groupDMStore";
import { useBlockStore } from "../stores/blockStore";
import { usePreferencesStore } from "../stores/preferencesStore";
import { useE2EEStore } from "../stores/e2eeStore";
import { shouldSuppressMessagePreview } from "./messageSpamPolicy";
import { isGroupMessageNotification } from "./dmMessageNotification";
import type { AppNotification } from "../types/notification";

export function groupNotificationSource(n: AppNotification, requireMessage = false) {
  const auth = getAuthSessionSnapshot(), state = useGroupDMStore.getState();
  if (!isGroupMessageNotification(n) || !auth.ownerId || n.user_id !== auth.ownerId || n.actor_id === auth.ownerId
    || useAuthStore.getState().user?.id !== auth.ownerId || state.ownerId !== auth.ownerId
    || state.authGeneration !== auth.generation || !state.groupsReady || state.loading) return null;
  const group = state.groups.find(g => g.id === n.group_dm_channel_id);
  if (!group || group.is_muted || !Number.isSafeInteger(group.key_epoch) || group.key_epoch < 1
    || group.read_key_epoch !== group.key_epoch || !Array.isArray(group.members) || !group.members.some(m => m.id === auth.ownerId)) return null;
  const blocks = useBlockStore.getState(), prefs = usePreferencesStore.getState();
  if (blocks.ownerId !== auth.ownerId || blocks.authGeneration !== auth.generation || !blocks.snapshotReady || blocks.isLoading
    || blocks.blockedUserIds.includes(n.actor_id!) || prefs.accountId !== auth.ownerId || !prefs.isLoaded
    || prefs.get<{ ignoredUsers?: Record<string, boolean> }>("privacy")?.ignoredUsers?.[n.actor_id!]) return null;
  const message = state.messages[group.id]?.find(m => m.id === n.message_id);
  if (message) {
    const e2ee = useE2EEStore.getState();
    // A source encrypted before the current rekey remains a legitimate source.
    if (message.group_id !== group.id || message.user_id !== n.actor_id || message.content === null
      || shouldSuppressMessagePreview(message, "group") || (message.encryption_version === 1
        && (e2ee.initStatus !== "ready" || e2ee.decryptionErrors.some(e => e.channelId === group.id && e.messageId === message.id)))) return null;
  } else if (requireMessage) return null;
  return { group, message, ownerId: auth.ownerId, generation: auth.generation, epoch: group.key_epoch };
}

/** Refresh metadata without requesting any plaintext or mutating a draft/read state. */
export async function refreshGroupNotificationAccess(n: AppNotification, epoch: number, isCurrent: () => boolean) {
  const current = () => isCurrent() && groupNotificationSource(n)?.epoch === epoch;
  if (!current()) return false;
  const result = await listGroupDMs({ isCurrent: current });
  const listed = result.success ? result.data?.group_dms : undefined;
  const live = Array.isArray(listed) && listed.find(g => g.id === n.group_dm_channel_id);
  return current() && !!live && live.key_epoch === epoch && live.read_key_epoch === epoch && !live.is_muted
    && Array.isArray(live.members) && live.members.some(m => m.id === n.user_id);
}
