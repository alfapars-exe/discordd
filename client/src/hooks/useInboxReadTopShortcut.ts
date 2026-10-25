import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { getAuthGeneration } from "../api/client";
import { markDMRead } from "../api/dm";
import { useAuthStore } from "../stores/authStore";
import { useDMStore } from "../stores/dmStore";
import { useToastStore } from "../stores/toastStore";
import { useUIStore } from "../stores/uiStore";
import { UI_SHELL_V2 } from "../utils/uiShell";
import type { InboxDMRow } from "./useInboxDMs";
import { selectTopUnreadInboxRow } from "./useInboxDMs";
import { useInboxShortcutAction } from "./useInboxShortcutAction";

function isActiveInbox(panelId?: string): boolean {
  const state = useUIStore.getState();
  const panel = state.panels[state.activePanelId];
  const tab = panel?.tabs.find((item) => item.id === panel.activeTabId);
  if (tab?.type !== "inbox" || (panelId && state.activePanelId !== panelId)) return false;
  // The classic shell derives its current Inbox from the active split-panel
  // tab; V2 additionally has a single authoritative destination.
  return !UI_SHELL_V2 || state.destination.type === "inbox";
}

/** Mark only the latest unread item in the Inbox's rendered section/order as read. */
export function useInboxReadTopShortcut(
  enabled: boolean,
  panelId: string | undefined,
  requests: InboxDMRow[],
  conversations: InboxDMRow[],
): void {
  const { t } = useTranslation("common");
  const ownerId = useAuthStore((state) => state.user?.id);
  const authGeneration = getAuthGeneration();
  const pendingKeys = useRef(new Set<string>());
  // A panel can briefly survive an auth-store update while its rows still
  // belong to the previous account. Do not rebind this mounted listener to a
  // new owner; logout resets navigation and the next Inbox mount gets a fresh
  // binding after that account's channel data is loaded.
  const accountBinding = useRef({ ownerId, authGeneration });

  useInboxShortcutAction("inbox-read-top", () => {
    if (!enabled || !ownerId || ownerId !== accountBinding.current.ownerId ||
        authGeneration !== accountBinding.current.authGeneration || useAuthStore.getState().user?.id !== ownerId ||
        getAuthGeneration() !== authGeneration || !isActiveInbox(panelId)) return false;
    const row = selectTopUnreadInboxRow(requests, conversations);
    const channelId = row?.dm.id;
    const messageId = row?.dm.last_message?.id;
    if (!row || !channelId || !messageId) return false;

    // The store may have received a newer message since the last render. Do
    // not acknowledge a stale anchor or act on an unread count already cleared.
    const liveState = useDMStore.getState();
    const liveChannel = liveState.channels.find((channel) => channel.id === channelId);
    if (!liveChannel || (liveState.dmUnreadCounts[channelId] ?? 0) <= 0 || liveChannel.last_message?.id !== messageId) return false;

    const requestKey = JSON.stringify([ownerId, authGeneration, panelId ?? "", channelId, messageId]);
    if (pendingKeys.current.has(requestKey)) return false;
    pendingKeys.current.add(requestKey);
    const isCurrent = () => useAuthStore.getState().user?.id === ownerId &&
      getAuthGeneration() === authGeneration && isActiveInbox(panelId);

    void (async () => {
      try {
        if (!isCurrent()) return;
        const response = await markDMRead(channelId, messageId);
        if (!isCurrent()) return;
        if (!response.success) {
          useToastStore.getState().addToast("error", t("somethingWentWrong"));
          return;
        }
        // This refresh updates channel metadata/unread counts only. Do not
        // fetch or replace message history: live/concurrent messages remain
        // in the DM store, and the exact message ID above is the read cursor.
        const refreshed = await useDMStore.getState().fetchChannels();
        if (!isCurrent() || !refreshed) {
          if (isCurrent()) useToastStore.getState().addToast("error", t("somethingWentWrong"));
        }
      } catch {
        if (isCurrent()) useToastStore.getState().addToast("error", t("somethingWentWrong"));
      } finally {
        pendingKeys.current.delete(requestKey);
      }
    })();
    return true;
  });
}
