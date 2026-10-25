import { getAuthSessionSnapshot } from "../api/authSessionEvents";
import { useGroupDMStore } from "../stores/groupDMStore";
import { useE2EEStore } from "../stores/e2eeStore";
import { useUIStore } from "../stores/uiStore";
import { useMobileStore } from "../stores/mobileStore";
import { useToastStore } from "../stores/toastStore";
import { UI_SHELL_V2 } from "./uiShell";
import i18n from "../i18n";

/** One main-chat exact-source jump shared by inbox/overlay and explicit OS clicks. */
export async function openGroupMessageAt(groupId: string, messageId: string,
  context?: { isCurrent: () => boolean; fallbackLabel?: string; goneLabel?: string }): Promise<boolean> {
  const auth = getAuthSessionSnapshot(), initial = useGroupDMStore.getState();
  const group = initial.groups.find(item => item.id === groupId), device = useE2EEStore.getState().localDeviceId;
  const current = () => {
    const now = getAuthSessionSnapshot(), state = useGroupDMStore.getState(), live = state.groups.find(item => item.id === groupId);
    return (!context || context.isCurrent()) && !!group && now.ownerId === auth.ownerId && now.generation === auth.generation
      && state.ownerId === auth.ownerId && state.authGeneration === auth.generation && state.groupsReady && !state.loading
      && useE2EEStore.getState().localDeviceId === device && live?.key_epoch === group.key_epoch
      && live.members.some(member => member.id === auth.ownerId);
  };
  if (!current() || !auth.ownerId || !group) return false;
  useUIStore.getState().openTab(groupId, "group-dm", group.name || context?.fallbackLabel || i18n.t("common:directMessages"));
  const revision = useUIStore.getState().navigationRevision;
  const found = await initial.fetchMessagesAround(groupId, messageId, { isCurrent: current });
  if (!current()) return false;
  const ui = useUIStore.getState();
  if (UI_SHELL_V2 && (ui.navigationRevision !== revision || ui.destination.type !== "group-dm" || ui.destination.channelId !== groupId)) return false;
  if (!found) { useToastStore.getState().addToast("info", context?.goneLabel || i18n.t("saved:messageGone")); return false; }
  if (useGroupDMStore.getState().setScrollTarget(groupId, messageId) === null) return false;
  useMobileStore.getState().closeAllDrawers();
  return true;
}
