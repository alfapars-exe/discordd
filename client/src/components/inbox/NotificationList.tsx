/**
 * NotificationList — feed rows from notificationStore, shared by the bell
 * popover (capped, no paging) and the full Notifications tab (paged).
 */

import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useNotificationStore } from "../../stores/notificationStore";
import { useNotificationNavigation } from "../../hooks/useNotificationNavigation";
import NotificationItem from "./NotificationItem";
import type { AppNotification } from "../../types";

type NotificationListProps = {
  limit?: number;
  /** Show the "load more" control when the server has older rows. */
  paged?: boolean;
  /** Called after a row is opened (popovers close themselves here). */
  onNavigate?: () => void;
};

function NotificationList({ limit, paged = false, onNavigate }: NotificationListProps) {
  const { t } = useTranslation("inbox");
  const items = useNotificationStore((s) => s.items);
  const hasMore = useNotificationStore((s) => s.hasMore);
  const isLoading = useNotificationStore((s) => s.isLoading);
  const fetchInitial = useNotificationStore((s) => s.fetchInitial);
  const fetchMore = useNotificationStore((s) => s.fetchMore);
  const navigate = useNotificationNavigation();

  // Refresh the window on mount — both the popover opening and the tab
  // opening count as "the user is looking now".
  useEffect(() => {
    fetchInitial();
  }, [fetchInitial]);

  function handleOpen(n: AppNotification) {
    navigate(n);
    onNavigate?.();
  }

  const visible = limit !== undefined ? items.slice(0, limit) : items;

  if (visible.length === 0) {
    return (
      <div className="inbox-empty">{isLoading ? t("common:loading") : t("noNotifications")}</div>
    );
  }

  return (
    <div className="notif-list">
      {visible.map((n) => (
        <NotificationItem key={n.id} notification={n} onOpen={handleOpen} />
      ))}
      {paged && hasMore && (
        <button
          type="button"
          className="inbox-link-btn inbox-load-more"
          onClick={fetchMore}
          disabled={isLoading}
        >
          {isLoading ? t("common:loading") : t("loadMore")}
        </button>
      )}
    </div>
  );
}

export default NotificationList;
