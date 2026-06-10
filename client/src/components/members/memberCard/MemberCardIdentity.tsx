/** MemberCardIdentity — top section of the MemberCard popover: header bar,
 *  badge pills, avatar, name + nickname editor, join date, active-timeout
 *  banner and role pills. Also renders the mc-body wrapper; the remaining
 *  card sections (status picker / actions / moderation) come in through
 *  `children` so the DOM structure matches the pre-split markup. */

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { MemberWithRoles, Role, UserBadge } from "../../../types";
import Avatar from "../../shared/Avatar";
import BadgePill from "../../shared/BadgePill";
import RoleBadge from "../RoleBadge";
import { formatFullDateTime, formatRelativeFuture } from "../../../utils/dateFormat";

type Props = {
  member?: MemberWithRoles;
  username: string;
  displayName?: string | null;
  avatarUrl?: string | null;
  customStatus?: string | null;
  userBadges: UserBadge[];
  joinDate: string;
  canEditNickname: boolean;
  nicknameDraft: string | null;
  setNicknameDraft: (draft: string | null) => void;
  openNicknameEditor: () => void;
  handleSaveNickname: () => void;
  isServerContext: boolean;
  timeoutExpiresAt?: string;
  canTimeout: boolean;
  handleRemoveTimeout: () => void;
  sortedRoles: Role[];
  onClose: () => void;
  children?: ReactNode;
};

function MemberCardIdentity({
  member,
  username,
  displayName,
  avatarUrl,
  customStatus,
  userBadges,
  joinDate,
  canEditNickname,
  nicknameDraft,
  setNicknameDraft,
  openNicknameEditor,
  handleSaveNickname,
  isServerContext,
  timeoutExpiresAt,
  canTimeout,
  handleRemoveTimeout,
  sortedRoles,
  onClose,
  children,
}: Props) {
  const { t, i18n } = useTranslation("common");

  return (
    <>
      {/* Header bar */}
      <div className="mc-header">
        <svg className="mc-header-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" /><circle cx="12" cy="7" r="4" />
        </svg>
        <span className="mc-header-title">{t("userProfile")}</span>
        <button className="mc-header-close" onClick={onClose}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      {/* User badges */}
      {userBadges.length > 0 && (
        <div className="mc-badges-top">
          {userBadges.map((ub) => {
            const badge = ub.badge;
            if (!badge) return null;
            return <BadgePill key={ub.id} badge={badge} size="md" />;
          })}
        </div>
      )}

      {/* Avatar area */}
      <div className="mc-avatar-area">
        <div className="mc-avatar-ring">
          <Avatar
            name={displayName ?? username}
            avatarUrl={avatarUrl}
            size={80}
            isCircle
          />
        </div>
      </div>

      {/* Body */}
      <div className="mc-body">
        <div className="mc-identity">
          {/* Per-server nickname takes precedence over the global
              display name; falls back to display_name → username.
              Edit pencil shows when the viewer is either renaming
              themselves OR has ManageNicknames for others. */}
          <div className="mc-name">
            {member?.nickname || displayName || username}
            {canEditNickname && nicknameDraft === null && (
              <button
                className="mc-name-edit"
                onClick={openNicknameEditor}
                title={t("editNickname", { defaultValue: "Takma adı düzenle" })}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 20h9" /><path d="M16.5 3.5a2.121 2.121 0 113 3L7 19l-4 1 1-4L16.5 3.5z" />
                </svg>
              </button>
            )}
          </div>
          {nicknameDraft !== null && (
            <div className="mc-name-editor">
              <input
                className="mc-name-input"
                autoFocus
                value={nicknameDraft}
                maxLength={32}
                onChange={(e) => setNicknameDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleSaveNickname();
                  if (e.key === "Escape") setNicknameDraft(null);
                }}
                placeholder={displayName ?? username}
              />
              <button className="mc-name-save" onClick={handleSaveNickname}>
                {t("save")}
              </button>
              <button className="mc-name-cancel" onClick={() => setNicknameDraft(null)}>
                {t("cancel")}
              </button>
            </div>
          )}
          {(displayName || member?.nickname) && <div className="mc-username">@{username}</div>}
          {customStatus && <div className="mc-custom-status">{customStatus}</div>}
          <div className="mc-join-date">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="4" width="18" height="18" rx="2" ry="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" />
            </svg>
            <span>{t("joinedAt", { date: joinDate })}</span>
          </div>
        </div>

        {/* Active moderator timeout banner — visible to everyone (so
            the target user themselves can see "you're muted until X"
            if they open their own card), but the Remove button only
            renders for mods with PermTimeoutMembers. */}
        {isServerContext && timeoutExpiresAt && (
          <div className="mc-timeout-banner" role="status">
            <svg
              className="mc-timeout-banner-icon"
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
            <div className="mc-timeout-banner-text">
              <strong>{t("timeoutActive")}</strong>
              <span title={formatFullDateTime(timeoutExpiresAt, i18n.language)}>
                {t("timeoutExpiresIn", {
                  rel: formatRelativeFuture(timeoutExpiresAt, i18n.language),
                })}
              </span>
            </div>
            {canTimeout && (
              <button
                className="mc-timeout-banner-action"
                onClick={handleRemoveTimeout}
                title={t("removeTimeoutTooltip")}
                type="button"
              >
                {t("removeTimeout")}
              </button>
            )}
          </div>
        )}

        {/* Roles (server context only) */}
        {sortedRoles.length > 0 && (
          <div className="mc-roles">
            {sortedRoles.map((role) => (
              <RoleBadge key={role.id} role={role} />
            ))}
          </div>
        )}

        {children}
      </div>
    </>
  );
}

export default MemberCardIdentity;
