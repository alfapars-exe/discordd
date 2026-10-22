/**
 * InboxPopover — portal popover under the header inbox icon: the 20 most
 * recent DM conversations (+ message requests) and a "view all" link that
 * opens the full Inbox tab.
 */

import { useTranslation } from "react-i18next";
import { useUIStore } from "../../stores/uiStore";
import { useMobileStore } from "../../stores/mobileStore";
import PopoverShell, { type PopoverAnchor } from "./PopoverShell";
import InboxList from "./InboxList";

const POPOVER_LIMIT = 20;

type InboxPopoverProps = {
  anchor: PopoverAnchor;
  onClose: () => void;
};

function InboxPopover({ anchor, onClose }: InboxPopoverProps) {
  const { t } = useTranslation("inbox");
  const openTab = useUIStore((s) => s.openTab);
  const closeAllDrawers = useMobileStore((s) => s.closeAllDrawers);

  function handleViewAll() {
    openTab("inbox", "inbox", t("inbox"));
    closeAllDrawers();
    onClose();
  }

  return (
    <PopoverShell anchor={anchor} onClose={onClose} ariaLabel={t("inbox")}>
      <div className="inbox-popover-header">
        <span className="inbox-popover-title">{t("inbox")}</span>
        <button type="button" className="inbox-link-btn" onClick={handleViewAll}>
          {t("viewAll")}
        </button>
      </div>
      <div className="inbox-popover-scroll">
        <InboxList limit={POPOVER_LIMIT} onNavigate={onClose} />
      </div>
    </PopoverShell>
  );
}

export default InboxPopover;
