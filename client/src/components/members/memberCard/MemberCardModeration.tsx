/** MemberCardModeration — kick / timeout / ban / temp-ban / role-manage
 *  action grid of the MemberCard popover. The parent owns the
 *  hasModActions guard; per-button permission flags and handlers come
 *  in as plain props from MemberCard. */

import { useTranslation } from "react-i18next";

type Props = {
  canKick: boolean;
  canTimeout: boolean;
  canBan: boolean;
  canManageRoles: boolean;
  handleKick: () => void;
  handleBan: () => void;
  setPickerMode: (mode: "timeout" | "tempban") => void;
  setShowRoleEditor: (open: boolean) => void;
};

function MemberCardModeration({
  canKick,
  canTimeout,
  canBan,
  canManageRoles,
  handleKick,
  handleBan,
  setPickerMode,
  setShowRoleEditor,
}: Props) {
  const { t } = useTranslation("common");

  return (
    <>
      <div className="mc-divider" />
      <div className="mc-section-title-row">
        <span className="mc-section-title">{t("moderation")}</span>
        <span className="mc-admin-tag">{t("adminAccess")}</span>
      </div>
      <div className="mc-actions">
        {canKick && (
          <button className="mc-btn mc-btn-default" onClick={handleKick}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" />
            </svg>
            <span>{t("kick")}</span>
          </button>
        )}
        {canTimeout && (
          <button className="mc-btn mc-btn-default" onClick={() => setPickerMode("timeout")}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
            </svg>
            <span>{t("timeout")}</span>
          </button>
        )}
        {canBan && (
          <button className="mc-btn mc-btn-ban" onClick={handleBan}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" /><line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
            </svg>
            <span>{t("ban")}</span>
          </button>
        )}
        {canBan && (
          <button className="mc-btn mc-btn-ban" onClick={() => setPickerMode("tempban")}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" /><line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
            </svg>
            <span>{t("tempBan")}</span>
          </button>
        )}
        {canManageRoles && (
          <button
            className="mc-btn mc-btn-roles-full"
            onClick={() => setShowRoleEditor(true)}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
            </svg>
            <span>{t("editRoles")}</span>
          </button>
        )}
      </div>
    </>
  );
}

export default MemberCardModeration;
