/**
 * SidebarHeader — Brand logo, search (Ctrl+K), and collapse toggle.
 */

import { useTranslation } from "react-i18next";
import { useSidebarStore } from "../../stores/sidebarStore";
import { useUIStore } from "../../stores/uiStore";
import { useMobileStore } from "../../stores/mobileStore";
import { useIsMobile } from "../../hooks/useMediaQuery";
import { publicAsset } from "../../utils/constants";
import HeaderInboxButtons from "../inbox/HeaderInboxButtons";
import SavedHeaderButton from "../saved/SavedHeaderButton";
import { UI_SHELL_V2 } from "../../utils/uiShell";

function SidebarHeader() {
  const { t } = useTranslation("common");
  const collapseSidebar = useSidebarStore((s) => s.collapseSidebar);
  const toggleQuickSwitcher = useUIStore((s) => s.toggleQuickSwitcher);
  const closeLeftDrawer = useMobileStore((s) => s.closeLeftDrawer);
  const isMobile = useIsMobile();

  if (UI_SHELL_V2) return <div className="shell-sidebar-search">
    <button className="sb-quick-search" onClick={toggleQuickSwitcher}><span>{t("quickSwitcherPlaceholder")}</span>{!isMobile && <kbd>Ctrl K</kbd>}</button>
    {isMobile && <button className="sb-header-btn" onClick={closeLeftDrawer} aria-label={t("closeSidebar")}>×</button>}
  </div>;

  return (
    <>
    <div className="sb-header">
      <div className="sb-header-brand">
        <img src={publicAsset("hlogo.png")} alt="HiChat!" className="sb-logo" />
        <span className="sb-brand-name">{t("appName")}</span>
      </div>

      <div className="sb-header-actions">
        {/* Inbox + notifications popovers */}
        <HeaderInboxButtons variant="header" />
        <SavedHeaderButton />

        {/* Collapse sidebar (mobile: closes drawer) */}
        <button
          className="sb-header-btn"
          onClick={isMobile ? closeLeftDrawer : collapseSidebar}
          title={t("closeSidebar")}
          aria-label={t("closeSidebar")}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
      </div>
    </div>
    <button className="sb-quick-search" onClick={toggleQuickSwitcher}>
      <span>{t("quickSwitcherPlaceholder")}</span>
      {!isMobile && <kbd>Ctrl K</kbd>}
    </button>
    </>
  );
}

export default SidebarHeader;
