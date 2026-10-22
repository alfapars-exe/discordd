/**
 * NotificationsView — full-tab activity feed with "unread only" filter,
 * "mark all read", and cursor paging ("load more").
 */

import { useTranslation } from "react-i18next";
import { useNotificationStore } from "../../stores/notificationStore";
import NotificationList from "./NotificationList";

function NotificationsView() {
  const { t } = useTranslation("inbox");
  const unreadCount = useNotificationStore((s) => s.unreadCount);
  const unreadOnly = useNotificationStore((s) => s.unreadOnly);
  const setUnreadOnly = useNotificationStore((s) => s.setUnreadOnly);
  const markAllRead = useNotificationStore((s) => s.markAllRead);

  return (
    <div className="inbox-view">
      <div className="inbox-view-header">
        <h2 className="inbox-view-title">{t("notifications")}</h2>
        <div className="inbox-view-actions">
          <label className="inbox-toggle">
            <input
              type="checkbox"
              checked={unreadOnly}
              onChange={(e) => setUnreadOnly(e.target.checked)}
            />
            <span>{t("unreadOnly")}</span>
          </label>
          <button
            type="button"
            className="inbox-link-btn"
            onClick={markAllRead}
            disabled={unreadCount === 0}
          >
            {t("markAllRead")}
          </button>
        </div>
      </div>
      <div className="inbox-view-content">
        <NotificationList paged />
      </div>
    </div>
  );
}

export default NotificationsView;
