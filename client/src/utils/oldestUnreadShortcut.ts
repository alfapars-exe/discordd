import { getAuthGeneration } from "../api/client";
import { getUnreadCounts } from "../api/readState";
import { listDMChannels } from "../api/dm";
import { listGroupDMs } from "../api/groupDM";
import { useAuthStore } from "../stores/authStore";
import { useUIStore } from "../stores/uiStore";
import { useMessageStore } from "../stores/messageStore";
import { useDMStore } from "../stores/dmStore";
import { useGroupDMStore } from "../stores/groupDMStore";
import { useToastStore } from "../stores/toastStore";
import i18n from "../i18n";
let latestJumpRequest = 0;

/** Never guesses an anchor from the loaded history and never changes the read cursor. */
export async function jumpToOldestUnread(): Promise<void> {
  if (document.querySelector("dialog[open], [role='dialog'], [role='menu'], .settings-overlay, .modal-backdrop") || window.getSelection()?.toString()) return;
  const initial = useUIStore.getState();
  const { destination, navigationRevision } = initial;
  const ownerId = useAuthStore.getState().user?.id;
  const generation = getAuthGeneration();
  const serverId = destination.serverInfo?.serverId;
  if (!ownerId || (destination.type !== "dm" && destination.type !== "group-dm" && ((destination.type !== "text" && destination.type !== "voice") || !serverId))) return;
  if (destination.type === "voice" && !document.querySelector(".messages-scroll")) return;
  const request = ++latestJumpRequest;
  const channelId = destination.channelId;
  const isCurrent = () => {
    const current = useUIStore.getState();
    return request === latestJumpRequest && ownerId === useAuthStore.getState().user?.id && generation === getAuthGeneration() &&
      current.navigationRevision === navigationRevision && current.destination.type === destination.type &&
      current.destination.channelId === channelId && current.destination.serverInfo?.serverId === serverId;
  };
  const toast = (kind: "info" | "error", key: string) => { if (isCurrent()) useToastStore.getState().addToast(kind, i18n.t(key)); };
  try {
    if (destination.type === "group-dm") {
      const response = await listGroupDMs({timeoutMs:15_000,isCurrent});
      if (!isCurrent()) return;
      if (!response.success) { toast("error","common:shortcutJumpFailed"); return; }
      const anchor = response.data?.group_dms.find(row=>row.id===channelId && row.unread_count>0)?.oldest_unread_message_id;
      if (!anchor) { toast("info","common:shortcutNoUnread"); return; }
      const found = await useGroupDMStore.getState().fetchMessagesAround(channelId,anchor,{isCurrent});
      if (!isCurrent()) return;
      if (!found) { toast("info","saved:messageGone"); return; }
      useGroupDMStore.getState().setScrollTarget(channelId,anchor);
      return;
    }
    if (destination.type === "dm") {
      const response = await listDMChannels({timeoutMs:15_000,isCurrent});
      if (!isCurrent()) return;
      if (!response.success) { toast("error","common:shortcutJumpFailed"); return; }
      const anchor = response.data?.find(row=>row.id===channelId && row.unread_count>0)?.oldest_unread_message_id;
      if (!anchor) { toast("info","common:shortcutNoUnread"); return; }
      const found = await useDMStore.getState().fetchMessagesAround(channelId,anchor,{isCurrent});
      if (!isCurrent()) return;
      if (!found) { toast("info","saved:messageGone"); return; }
      useDMStore.getState().setScrollToMessageId(anchor);
      return;
    }
    if (!serverId) return;
    const response = await getUnreadCounts(serverId, { timeoutMs: 15_000, isCurrent });
    if (!isCurrent()) return;
    if (!response.success) { toast("error", "common:shortcutJumpFailed"); return; }
    const anchor = response.data?.find(row => row.channel_id === channelId && row.unread_count > 0)?.oldest_unread_message_id;
    if (!anchor) { toast("info", "common:shortcutNoUnread"); return; }
    const found = await useMessageStore.getState().fetchAroundMessage(serverId, channelId, anchor, { timeoutMs: 15_000, isCurrent });
    if (!isCurrent()) return;
    if (!found) { toast("info", "saved:messageGone"); return; }
    useMessageStore.getState().setScrollToMessageId(anchor);
  } catch {
    toast("error", "common:shortcutJumpFailed");
  }
}
