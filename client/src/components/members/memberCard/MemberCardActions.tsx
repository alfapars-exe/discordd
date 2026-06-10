/** MemberCardActions — user action grids of the MemberCard popover:
 *  DM / voice call / video call / friend / block / report for other
 *  users, plus the badge-admin assign shortcut (own card included).
 *  All flags and handlers arrive as plain props from MemberCard. */

import { useTranslation } from "react-i18next";
import type { useConfirm } from "../../../hooks/useConfirm";

// FriendIcon — module-scope so React/ESLint sees it as a stable
// component identity. Defining it inside MemberCardActions' body would
// make it a "fresh" component every render, defeating reconciliation
// and triggering react-hooks/static-components.
function FriendIcon({ isFriend }: { isFriend: boolean }) {
  if (isFriend) {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M16 21v-2a4 4 0 00-4-4H5a4 4 0 00-4-4v2" /><circle cx="8.5" cy="7" r="4" /><line x1="18" y1="11" x2="23" y2="11" />
      </svg>
    );
  }
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M16 21v-2a4 4 0 00-4-4H5a4 4 0 00-4-4v2" /><circle cx="8.5" cy="7" r="4" /><line x1="20" y1="8" x2="20" y2="14" /><line x1="17" y1="11" x2="23" y2="11" />
    </svg>
  );
}

type Props = {
  isMe: boolean;
  isBadgeAdmin: boolean;
  isFriend: boolean;
  isBlocked: boolean;
  userId: string;
  username: string;
  handleSendMessage: () => void;
  handleVoiceCall: () => void;
  handleVideoCall: () => void;
  handleFriendAction: () => void;
  getFriendLabel: () => string;
  blockUser: (userId: string) => Promise<boolean>;
  unblockUser: (userId: string) => Promise<boolean>;
  confirm: ReturnType<typeof useConfirm>;
  setShowBadgeAssign: (open: boolean) => void;
  setShowReport: (open: boolean) => void;
};

function MemberCardActions({
  isMe,
  isBadgeAdmin,
  isFriend,
  isBlocked,
  userId,
  username,
  handleSendMessage,
  handleVoiceCall,
  handleVideoCall,
  handleFriendAction,
  getFriendLabel,
  blockUser,
  unblockUser,
  confirm,
  setShowBadgeAssign,
  setShowReport,
}: Props) {
  const { t } = useTranslation("common");

  return (
    <>
      {/* User Actions */}
      {!isMe && (
        <>
          <div className="mc-divider" />
          <div className="mc-section-title">{t("userActions")}</div>
          <div className="mc-actions">
            <button className="mc-btn mc-btn-primary" onClick={handleSendMessage}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z" />
              </svg>
              <span>{t("sendMessage")}</span>
            </button>
            <button className="mc-btn mc-btn-default" onClick={handleVoiceCall}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z" />
              </svg>
              <span>{t("voiceCall")}</span>
            </button>
            <button className="mc-btn mc-btn-default" onClick={handleVideoCall}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M15.75 10.5l4.72-4.72a.75.75 0 011.28.53v11.38a.75.75 0 01-1.28.53l-4.72-4.72M4.5 18.75h9.75a2.25 2.25 0 002.25-2.25V7.5a2.25 2.25 0 00-2.25-2.25H4.5A2.25 2.25 0 002.25 7.5v9a2.25 2.25 0 002.25 2.25z" />
              </svg>
              <span>{t("videoCall")}</span>
            </button>
            <button
              className={`mc-btn${isFriend ? " mc-btn-danger" : " mc-btn-default"}`}
              onClick={handleFriendAction}
            >
              <FriendIcon isFriend={isFriend} />
              <span>{getFriendLabel()}</span>
            </button>
            {isBadgeAdmin && (
              <button
                className="mc-btn mc-btn-default"
                onClick={() => setShowBadgeAssign(true)}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="8" r="7" /><polyline points="8.21 13.89 7 23 12 20 17 23 15.79 13.88" />
                </svg>
                <span>{t("assignBadge")}</span>
              </button>
            )}
            <button
              className={`mc-btn${isBlocked ? " mc-btn-default" : " mc-btn-danger"}`}
              onClick={async () => {
                if (isBlocked) {
                  await unblockUser(userId);
                } else {
                  const ok = await confirm({
                    message: t("confirmBlock", { username }),
                    confirmLabel: t("block"),
                    danger: true,
                  });
                  if (ok) await blockUser(userId);
                }
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" /><line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
              </svg>
              <span>{isBlocked ? t("unblock") : t("block")}</span>
            </button>
            <button
              className="mc-btn mc-btn-danger"
              onClick={() => setShowReport(true)}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" /><line x1="4" y1="22" x2="4" y2="15" />
              </svg>
              <span>{t("report")}</span>
            </button>
          </div>
        </>
      )}

      {/* Badge admin action when viewing own card */}
      {isBadgeAdmin && isMe && (
        <>
          <div className="mc-divider" />
          <div className="mc-actions">
            <button
              className="mc-btn mc-btn-default"
              style={{ gridColumn: "1/-1" }}
              onClick={() => setShowBadgeAssign(true)}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="8" r="7" /><polyline points="8.21 13.89 7 23 12 20 17 23 15.79 13.88" />
              </svg>
              <span>{t("assignBadge")}</span>
            </button>
          </div>
        </>
      )}
    </>
  );
}

export default MemberCardActions;
