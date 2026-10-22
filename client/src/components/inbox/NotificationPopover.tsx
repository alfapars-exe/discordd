/**
 * NotificationPopover — portal popover under the header bell icon: the 20
 * most recent feed rows, "mark all read", and a "view all" link that opens
 * the full Notifications tab.
 */

import { useTranslation } from "react-i18next";
import { useUIStore } from "../../stores/uiStore";
import { useMobileStore } from "../../stores/mobileStore";
import { useNotificationStore } from "../../stores/notificationStore";
import PopoverShell, { type PopoverAnchor } from "./PopoverShell";
import NotificationList from "./NotificationList";

const POPOVER_LIMIT = 20;

type NotificationPopoverProps = {
  anchor: PopoverAnchor;
  onClose: () => void;
};

function NotificationPopover({ anchor, onClose }: NotificationPopoverProps) {
  const { t } = useTranslation("inbox");
  const openTab = useUIStore((s) => s.openTab);
  const closeAllDrawers = useMobileStore((s) => s.closeAllDrawers);
  const unreadCount = useNotificationStore((s) => s.unreadCount);
  const markAllRead = useNotificationStore((s) => s.markAllRead);

  function handleViewAll() {
    openTab("notifications", "notifications", t("notifications"));
    closeAllDrawers();
    onClose();
  }

  return (
    <PopoverShell anchor={anchor} onClose={onClose} ariaLabel={t("notifications")}>
      <div className="inbox-popover-header">
        <span className="inbox-popover-title">{t("notifications")}</span>
        <span className="inbox-popover-actions">
          <button
            type="button"
            className="inbox-link-btn"
            onClick={markAllRead}
            disabled={unreadCount === 0}
          >
            {t("markAllRead")}
          </button>
          <button type="button" className="inbox-link-btn" onClick={handleViewAll}>
            {t("viewAll")}
          </button>
        </span>
      </div>
      <div className="inbox-popover-scroll">
        <NotificationList limit={POPOVER_LIMIT} onNavigate={onClose} />
      </div>
    </PopoverShell>
  );
}

export default NotificationPopover;
