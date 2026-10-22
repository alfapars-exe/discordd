/**
 * HeaderInboxButtons — Inbox (DM tray) + Notifications (bell) icon pair with
 * unread badges. Clicking toggles the matching popover; only one is open at
 * a time. Rendered in three places with a `variant` that picks the button
 * class and popover placement:
 *   header → SidebarHeader actions (next to search)
 *   rail   → CollapsedSidebar (52px strip, popover opens to the right)
 *   mobile → MobileHeader (popover becomes a full-width sheet)
 */

import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDMStore } from "../../stores/dmStore";
import { useNotificationStore } from "../../stores/notificationStore";
import { IconInbox, IconBell } from "../shared/Icons";
import InboxPopover from "./InboxPopover";
import NotificationPopover from "./NotificationPopover";
import type { PopoverAnchor } from "./PopoverShell";

type Variant = "header" | "rail" | "mobile";

type HeaderInboxButtonsProps = {
  variant: Variant;
};

type OpenPanel = "inbox" | "notifications" | null;

const BUTTON_CLASS: Record<Variant, string> = {
  header: "sb-header-btn",
  rail: "sb-collapsed-btn",
  mobile: "mobile-header-btn",
};

const ICON_SIZE: Record<Variant, number> = { header: 16, rail: 18, mobile: 22 };

function formatBadge(count: number): string {
  return count > 99 ? "99+" : String(count);
}

function HeaderInboxButtons({ variant }: HeaderInboxButtonsProps) {
  const { t } = useTranslation("inbox");
  const dmUnread = useDMStore((s) => s.getTotalDMUnread());
  const notifUnread = useNotificationStore((s) => s.unreadCount);

  const [open, setOpen] = useState<OpenPanel>(null);
  const [anchor, setAnchor] = useState<PopoverAnchor | null>(null);
  const inboxBtnRef = useRef<HTMLButtonElement>(null);
  const bellBtnRef = useRef<HTMLButtonElement>(null);

  const close = useCallback(() => setOpen(null), []);

  function toggle(panel: Exclude<OpenPanel, null>, btn: HTMLButtonElement | null) {
    if (open === panel) {
      setOpen(null);
      return;
    }
    if (!btn) return;
    setAnchor({
      rect: btn.getBoundingClientRect(),
      placement: variant === "rail" ? "right" : "below",
    });
    setOpen(panel);
  }

  const btnClass = BUTTON_CLASS[variant];
  const size = ICON_SIZE[variant];
  const badgeClass = variant === "rail" ? "sb-collapsed-badge" : "hib-badge";

  return (
    <>
      <button
        ref={inboxBtnRef}
        type="button"
        className={`${btnClass} hib-btn${open === "inbox" ? " active" : ""}`}
        onClick={() => toggle("inbox", inboxBtnRef.current)}
        title={t("inbox")}
        aria-label={t("inbox")}
        aria-haspopup="dialog"
        aria-expanded={open === "inbox"}
      >
        <IconInbox width={size} height={size} />
        {dmUnread > 0 && <span className={badgeClass}>{formatBadge(dmUnread)}</span>}
      </button>
      <button
        ref={bellBtnRef}
        type="button"
        className={`${btnClass} hib-btn${open === "notifications" ? " active" : ""}`}
        onClick={() => toggle("notifications", bellBtnRef.current)}
        title={t("notifications")}
        aria-label={t("notifications")}
        aria-haspopup="dialog"
        aria-expanded={open === "notifications"}
      >
        <IconBell width={size} height={size} />
        {notifUnread > 0 && <span className={badgeClass}>{formatBadge(notifUnread)}</span>}
      </button>

      {open === "inbox" && anchor && <InboxPopover anchor={anchor} onClose={close} />}
      {open === "notifications" && anchor && (
        <NotificationPopover anchor={anchor} onClose={close} />
      )}
    </>
  );
}

export default HeaderInboxButtons;
