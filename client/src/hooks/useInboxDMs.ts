/**
 * useInboxDMs — DM rows for the Inbox popover / full tab.
 *
 * Derives from dmStore: conversations sorted by latest activity (newest
 * first), split into incoming message requests vs. normal conversations,
 * each with a ready-to-render preview line. `openDM` mirrors the sidebar
 * DMSection click path so both entry points behave identically.
 */

import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useDMStore } from "../stores/dmStore";
import { useUIStore } from "../stores/uiStore";
import { useAuthStore } from "../stores/authStore";
import { useMobileStore } from "../stores/mobileStore";
import type { DMChannelWithUser } from "../types";

export type InboxDMRow = {
  dm: DMChannelWithUser;
  name: string;
  /** Preview text, already localised for E2EE / attachment fallbacks. */
  preview: string;
  /** Whether the last message was sent by the current user. */
  isOwn: boolean;
  unread: number;
  /** Sort key: last activity ISO timestamp. */
  activityAt: string;
};

/** Return the first unread row in the same section/order that InboxList renders. */
export function selectTopUnreadInboxRow(requests: InboxDMRow[], conversations: InboxDMRow[]): InboxDMRow | undefined {
  return [...requests, ...conversations].find((row) => row.unread > 0);
}

export function useInboxDMs(limit?: number) {
  const { t } = useTranslation("inbox");
  const channels = useDMStore((s) => s.channels);
  const dmUnreadCounts = useDMStore((s) => s.dmUnreadCounts);
  const messagesByChannel = useDMStore((s) => s.messagesByChannel);
  const selectDM = useDMStore((s) => s.selectDM);
  const clearDMUnread = useDMStore((s) => s.clearDMUnread);
  const fetchMessages = useDMStore((s) => s.fetchMessages);
  const openTab = useUIStore((s) => s.openTab);
  const closeAllDrawers = useMobileStore((s) => s.closeAllDrawers);
  const currentUserId = useAuthStore((s) => s.user?.id);

  const { requests, conversations } = useMemo(() => {
    // Self-DM ("My Notes") is not a conversation — it has its own sidebar row.
    const sorted = channels.filter((c) => c.other_user.id !== currentUserId).sort((a, b) =>
      (b.last_message_at ?? b.created_at).localeCompare(a.last_message_at ?? a.created_at)
    );
    const limited = limit !== undefined ? sorted.slice(0, limit) : sorted;

    const toRow = (dm: DMChannelWithUser): InboxDMRow => {
      const last = dm.last_message;
      let preview = "";
      if (last) {
        if (last.content) {
          preview = last.content;
        } else if (last.encryption_version === 1) {
          // The REST list never carries E2EE plaintext; if this session has
          // already decrypted the same message, reuse its content.
          const loaded = messagesByChannel[dm.id];
          const tail = loaded && loaded.length > 0 ? loaded[loaded.length - 1] : undefined;
          preview = tail && tail.id === last.id && tail.content
            ? tail.content
            : t("encryptedMessage");
        } else {
          preview = t("attachment");
        }
      }
      return {
        dm,
        name: dm.other_user.display_name || dm.other_user.username,
        preview,
        isOwn: !!last && last.user_id === currentUserId,
        unread: dmUnreadCounts[dm.id] ?? 0,
        activityAt: dm.last_message_at ?? dm.created_at,
      };
    };

    const requests: InboxDMRow[] = [];
    const conversations: InboxDMRow[] = [];
    for (const dm of limited) {
      const row = toRow(dm);
      if (dm.status === "pending" && dm.initiated_by !== currentUserId) {
        requests.push(row);
      } else {
        conversations.push(row);
      }
    }
    return { requests, conversations };
  }, [channels, dmUnreadCounts, messagesByChannel, currentUserId, limit, t]);

  const openDM = useCallback(
    (row: InboxDMRow) => {
      selectDM(row.dm.id);
      openTab(row.dm.id, "dm", row.name);
      clearDMUnread(row.dm.id);
      fetchMessages(row.dm.id);
      closeAllDrawers();
    },
    [selectDM, openTab, clearDMUnread, fetchMessages, closeAllDrawers]
  );

  return { requests, conversations, openDM };
}
