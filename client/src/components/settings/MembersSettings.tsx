/** MembersSettings — Member management with role assignment, kick/ban, and ban list. */

import { useEffect, useState, useMemo, useCallback } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useMemberStore, useActiveMembers, useMemberTimeout } from "../../stores/memberStore";
import { useRoleStore, useActiveRoles } from "../../stores/roleStore";
import { useAuthStore } from "../../stores/authStore";
import { useToastStore } from "../../stores/toastStore";
import { showApiError } from "../../utils/apiError";
import { useConfirm } from "../../hooks/useConfirm";
import { hasPermission, Permissions } from "../../utils/permissions";
import * as memberApi from "../../api/members";
import { useServerStore } from "../../stores/serverStore";
import { resolveAssetUrl } from "../../utils/constants";
import { formatDate, formatFullDateTime, formatRelativeFuture } from "../../utils/dateFormat";
import ModDurationPicker from "../members/ModDurationPicker";
import { TIMEOUT_PRESETS } from "../members/modDurationPresets";
import type { Ban } from "../../types";

type Tab = "members" | "bans";

function MembersSettings() {
  const { t, i18n } = useTranslation("settings");
  const members = useActiveMembers();
  const fetchMembers = useMemberStore((s) => s.fetchMembers);
  const roles = useActiveRoles();
  const fetchRoles = useRoleStore((s) => s.fetchRoles);
  const currentUser = useAuthStore((s) => s.user);
  const addToast = useToastStore((s) => s.addToast);
  const confirm = useConfirm();

  const [activeTab, setActiveTab] = useState<Tab>("members");

  const [selectedMemberId, setSelectedMemberId] = useState<string | null>(null);
  const [editRoleIds, setEditRoleIds] = useState<string[]>([]);
  const [hasChanges, setHasChanges] = useState(false);

  const [bans, setBans] = useState<Ban[]>([]);
  const [isBansLoading, setIsBansLoading] = useState(false);
  const [selectedBanUserId, setSelectedBanUserId] = useState<string | null>(null);
  const [showTimeoutPicker, setShowTimeoutPicker] = useState(false);

  useEffect(() => {
    fetchMembers();
    fetchRoles();
  }, [fetchMembers, fetchRoles]);

  const selectedMember = members.find((m) => m.id === selectedMemberId);

  useEffect(() => {
    if (selectedMember) {
      queueMicrotask(() => {
        setEditRoleIds(selectedMember.roles.map((r) => r.id));
        setHasChanges(false);
      });
    }
  }, [selectedMember]);

  const myPerms = useMemo(() => {
    const me = members.find((m) => m.id === currentUser?.id);
    return me?.effective_permissions ?? 0;
  }, [members, currentUser]);

  const actorMaxPos = useMemo(() => {
    const me = members.find((m) => m.id === currentUser?.id);
    if (!me || me.roles.length === 0) return 0;
    return Math.max(...me.roles.map((r) => r.position));
  }, [members, currentUser]);

  const canManageRoles = hasPermission(myPerms, Permissions.ManageRoles);
  const canKick = hasPermission(myPerms, Permissions.KickMembers);
  const canBan = hasPermission(myPerms, Permissions.BanMembers);
  const canTimeout = hasPermission(myPerms, Permissions.TimeoutMembers);

  // Active moderator timeout for the selected member (if any) — falls back
  // to the inline field on the member object so the status row shows even
  // before the first WS event arrives, same pattern as MemberCard.
  const activeServerId = useServerStore((s) => s.activeServerId);
  const storeTimeout = useMemberTimeout(activeServerId, selectedMemberId);
  const selectedTimeoutExpiresAt =
    storeTimeout?.expires_at ?? selectedMember?.timeout_expires_at ?? undefined;

  const targetMaxPos = useMemo(() => {
    if (!selectedMember || selectedMember.roles.length === 0) return 0;
    return Math.max(...selectedMember.roles.map((r) => r.position));
  }, [selectedMember]);

  const isTargetOwner = selectedMember?.roles.some((r) => r.is_owner) ?? false;

  const canActOnTarget = !isTargetOwner && targetMaxPos < actorMaxPos;

  /** Highest role color for avatar border and name */
  function getMemberColor(member: typeof members[0]): string {
    if (member.roles.length === 0) return "var(--color-text-secondary)";
    const sorted = [...member.roles].sort((a, b) => b.position - a.position);
    return sorted[0].color || "var(--color-text-secondary)";
  }

  const fetchBans = useCallback(async () => {
    const serverId = useServerStore.getState().activeServerId;
    if (!serverId) return;
    setIsBansLoading(true);
    const res = await memberApi.getBans(serverId);
    if (res.data) {
      setBans(res.data);
    }
    setIsBansLoading(false);
  }, []);

  useEffect(() => {
    if (activeTab === "bans" && canBan) {
      queueMicrotask(() => fetchBans());
    }
  }, [activeTab, canBan, fetchBans]);

  // Client-side temp-ban expiry. The backend already filters expired
  // bans on every GET /bans, but once the page is open the moderator
  // would see stale rows until they refresh. One timer per visible
  // temp-ban row clears it locally the moment it expires. Cleans up
  // on unmount and whenever the bans list changes (which cancels and
  // reschedules timers for the new set).
  useEffect(() => {
    if (activeTab !== "bans") return;
    const handles: ReturnType<typeof setTimeout>[] = [];
    for (const ban of bans) {
      if (!ban.expires_at) continue;
      const ms = Date.parse(ban.expires_at) - Date.now();
      const SAFE_MAX = 2_147_483_647; // setTimeout cap (~24.8 days)
      const delay = Math.max(0, Math.min(ms, SAFE_MAX));
      const h = setTimeout(() => {
        setBans((prev) => prev.filter((b) => b.user_id !== ban.user_id));
        setSelectedBanUserId((id) => (id === ban.user_id ? null : id));
      }, delay);
      handles.push(h);
    }
    return () => {
      for (const h of handles) clearTimeout(h);
    };
  }, [bans, activeTab]);

  function handleTabChange(tab: Tab) {
    setActiveTab(tab);
    setSelectedMemberId(null);
    setSelectedBanUserId(null);
    setHasChanges(false);
  }

  const selectedBan = bans.find((b) => b.user_id === selectedBanUserId);

  function handleRoleToggle(roleId: string) {
    setEditRoleIds((prev) => {
      const next = prev.includes(roleId)
        ? prev.filter((id) => id !== roleId)
        : [...prev, roleId];
      return next;
    });
    setHasChanges(true);
  }

  async function handleSaveRoles() {
    if (!selectedMemberId || !hasChanges) return;

    const serverId = useServerStore.getState().activeServerId;
    if (!serverId) return;
    const res = await memberApi.modifyMemberRoles(serverId, selectedMemberId, editRoleIds);
    if (res.data) {
      setHasChanges(false);
      addToast("success", t("memberRolesSaved"));
    } else {
      showApiError(res, { fallbackKey: "settings:memberRolesSaveError" });
    }
  }

  async function handleKick() {
    if (!selectedMember) return;
    const displayName = selectedMember.display_name || selectedMember.username;
    const ok = await confirm({
      message: t("confirmKick", { name: displayName }),
      confirmLabel: t("kickMember"),
      danger: true,
    });
    if (!ok) return;

    const serverId = useServerStore.getState().activeServerId;
    if (!serverId) return;
    const res = await memberApi.kickMember(serverId, selectedMember.id);
    if (res.data) {
      addToast("success", t("memberKicked"));
      setSelectedMemberId(null);
    } else {
      showApiError(res, { fallbackKey: "settings:memberKickError" });
    }
  }

  async function handleBan() {
    if (!selectedMember) return;
    const displayName = selectedMember.display_name || selectedMember.username;
    const ok = await confirm({
      message: t("confirmBan", { name: displayName }),
      confirmLabel: t("banMember"),
      danger: true,
    });
    if (!ok) return;

    const serverId = useServerStore.getState().activeServerId;
    if (!serverId) return;
    const res = await memberApi.banMember(serverId, selectedMember.id, "Banned by admin");
    if (res.data) {
      addToast("success", t("memberBanned"));
      setSelectedMemberId(null);
    } else {
      showApiError(res, { fallbackKey: "settings:memberBanError" });
    }
  }

  async function handleRemoveTimeout() {
    if (!selectedMember) return;
    const serverId = useServerStore.getState().activeServerId;
    if (!serverId) return;
    const res = await memberApi.removeTimeout(serverId, selectedMember.id);
    if (res.success) {
      addToast("success", t("memberTimeoutRemoved"));
    } else {
      showApiError(res, { fallbackKey: "common:removeTimeoutError" });
    }
  }

  async function handleTimeoutPick(seconds: number) {
    setShowTimeoutPicker(false);
    if (!selectedMember) return;
    const serverId = useServerStore.getState().activeServerId;
    if (!serverId) return;
    const res = await memberApi.timeoutMember(serverId, selectedMember.id, seconds, "");
    if (res.success) {
      addToast("success", t("memberTimeoutApplied"));
    } else {
      showApiError(res, { fallbackKey: "common:timeoutError" });
    }
  }

  async function handleUnban() {
    if (!selectedBan) return;
    const ok = await confirm({
      message: t("confirmUnban", { name: selectedBan.username }),
      confirmLabel: t("unban"),
      danger: false,
    });
    if (!ok) return;

    const serverId = useServerStore.getState().activeServerId;
    if (!serverId) return;
    const res = await memberApi.unbanMember(serverId, selectedBan.user_id);
    if (res.data) {
      addToast("success", t("memberUnbanned"));
      setBans((prev) => prev.filter((b) => b.user_id !== selectedBan.user_id));
      setSelectedBanUserId(null);
    } else {
      showApiError(res, { fallbackKey: "settings:memberUnbanError" });
    }
  }

  const isSelf = selectedMemberId === currentUser?.id;

  function formatBanDate(dateStr: string): string {
    return formatDate(dateStr, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  }

  return (
    <div className="channel-settings-wrapper">
      {/* Left Panel */}
      <div className="role-list">
        {/* Tab toggle — only shown when user has BAN_MEMBERS */}
        {canBan ? (
          <div className="member-settings-tabs">
            <button
              onClick={() => handleTabChange("members")}
              className={`member-settings-tab${activeTab === "members" ? " active" : ""}`}
            >
              {t("members")} ({members.length})
            </button>
            <button
              onClick={() => handleTabChange("bans")}
              className={`member-settings-tab${activeTab === "bans" ? " active" : ""}`}
            >
              {t("bannedMembers")} ({bans.length})
            </button>
          </div>
        ) : (
          <div className="channel-settings-header">
            <span className="channel-settings-header-label">
              {t("members")} ({members.length})
            </span>
          </div>
        )}

        {/* Members List */}
        {activeTab === "members" && (
          <div className="channel-settings-ch-list">
            {members.map((member) => (
              <div
                key={member.id}
                onClick={() => setSelectedMemberId(member.id)}
                className={`role-list-item${member.id === selectedMemberId ? " active" : ""}`}
              >
                <div
                  className="member-settings-avatar"
                  style={{
                    borderColor: getMemberColor(member),
                  }}
                >
                  {member.avatar_url ? (
                    <img
                      src={resolveAssetUrl(member.avatar_url)}
                      alt={member.username}
                      className="member-settings-avatar-img"
                      loading="lazy"
                      decoding="async"
                    />
                  ) : (
                    <span className="member-settings-avatar-fallback">
                      {(member.display_name || member.username).charAt(0).toUpperCase()}
                    </span>
                  )}
                </div>

                <div className="member-settings-info">
                  <span
                    className="member-settings-name"
                    style={{ color: getMemberColor(member) }}
                  >
                    {member.display_name || member.username}
                  </span>
                  <span className="member-settings-username">
                    {member.username}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Bans List */}
        {activeTab === "bans" && (
          <div className="channel-settings-ch-list">
            {isBansLoading ? (
              <div className="no-channel">
                {t("loading", { ns: "common" })}
              </div>
            ) : bans.length === 0 ? (
              <div className="no-channel">
                {t("noBannedMembers")}
              </div>
            ) : (
              bans.map((ban) => (
                <div
                  key={ban.user_id}
                  onClick={() => setSelectedBanUserId(ban.user_id)}
                  className={`role-list-item${ban.user_id === selectedBanUserId ? " active" : ""}`}
                >
                  <div className="member-settings-avatar member-settings-avatar-banned">
                    <span className="member-settings-avatar-fallback">
                      {ban.username.charAt(0).toUpperCase()}
                    </span>
                  </div>

                  <div className="member-settings-info">
                    <span className="member-settings-name member-settings-name-banned">
                      {ban.username}
                      {ban.expires_at && (
                        <span className="ban-row-temp-pill">{t("banTemporaryBadge")}</span>
                      )}
                    </span>
                    <span className="member-settings-username">
                      {ban.expires_at
                        ? t("banExpiresIn", {
                            rel: formatRelativeFuture(ban.expires_at, i18n.language),
                          })
                        : formatBanDate(ban.created_at)}
                    </span>
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {/* Right Panel */}
      <div className="settings-content channel-settings-right">
        {/* ─── Members Tab — Right Panel ─── */}
        {activeTab === "members" && (
          <>
            {selectedMember ? (
              <div className="channel-perm-section">
                <div className="member-settings-detail-header">
                  <div
                    className="member-settings-avatar member-settings-avatar-lg"
                    style={{ borderColor: getMemberColor(selectedMember) }}
                  >
                    {selectedMember.avatar_url ? (
                      <img
                        src={resolveAssetUrl(selectedMember.avatar_url)}
                        alt={selectedMember.username}
                        className="member-settings-avatar-img"
                        loading="lazy"
                        decoding="async"
                      />
                    ) : (
                      <span className="member-settings-avatar-fallback">
                        {(selectedMember.display_name || selectedMember.username).charAt(0).toUpperCase()}
                      </span>
                    )}
                  </div>
                  <div>
                    <div
                      className="member-settings-detail-name"
                      style={{ color: getMemberColor(selectedMember) }}
                    >
                      {selectedMember.display_name || selectedMember.username}
                    </div>
                    <div className="member-settings-detail-username">
                      @{selectedMember.username}
                    </div>
                  </div>
                </div>

                <div className="settings-field">
                  <label className="settings-label">{t("memberCurrentRoles")}</label>
                  <div className="member-settings-role-tags">
                    {selectedMember.roles.length === 0 ? (
                      <span className="member-settings-no-roles">{t("memberNoRoles")}</span>
                    ) : (
                      selectedMember.roles.map((role) => (
                        <span
                          key={role.id}
                          className="member-settings-role-tag"
                          style={{ borderColor: role.color || "var(--color-text-muted)" }}
                        >
                          <span
                            className="role-list-dot"
                            style={{ backgroundColor: role.color || "#99AAB5" }}
                          />
                          {role.name}
                        </span>
                      ))
                    )}
                  </div>
                </div>

                {/* Role assignment — requires ManageRoles + hierarchy check */}
                {canManageRoles && canActOnTarget && !isSelf && (
                  <div className="settings-field">
                    <label className="settings-label">{t("memberAssignRoles")}</label>
                    <div className="member-settings-role-checkboxes">
                      {roles
                        .filter((role) => role.id !== "owner" && !role.is_default && role.position < actorMaxPos)
                        .map((role) => (
                        <label key={role.id} className="member-settings-role-checkbox">
                          <input
                            type="checkbox"
                            checked={editRoleIds.includes(role.id)}
                            onChange={() => handleRoleToggle(role.id)}
                          />
                          <span
                            className="role-list-dot"
                            style={{ backgroundColor: role.color || "#99AAB5" }}
                          />
                          <span>{role.name}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                )}

                {canManageRoles && canActOnTarget && hasChanges && !isSelf && (
                  <div className="member-settings-actions">
                    <button onClick={handleSaveRoles} className="settings-btn">
                      {t("saveChanges")}
                    </button>
                    <p className="member-settings-unsaved">{t("unsavedChanges")}</p>
                  </div>
                )}

                {/* Kick / Ban / Timeout — only on others, with permission + hierarchy */}
                {!isSelf && canActOnTarget && (canKick || canBan || canTimeout) && (
                  <div className="settings-field">
                    <label className="settings-label">{t("dangerZone")}</label>
                    {canTimeout && selectedTimeoutExpiresAt && (
                      <p className="ban-detail-expiry">
                        {t("timeoutActiveUntil", {
                          ns: "common",
                          date: formatFullDateTime(selectedTimeoutExpiresAt, i18n.language),
                        })}
                      </p>
                    )}
                    <div className="member-settings-actions">
                      {canKick && (
                        <button
                          onClick={handleKick}
                          className="settings-btn settings-btn-danger"
                        >
                          {t("kickMember")}
                        </button>
                      )}
                      {canBan && (
                        <button
                          onClick={handleBan}
                          className="settings-btn settings-btn-danger"
                        >
                          {t("banMember")}
                        </button>
                      )}
                      {canTimeout && !selectedTimeoutExpiresAt && (
                        <button
                          onClick={() => setShowTimeoutPicker(true)}
                          className="settings-btn settings-btn-danger"
                        >
                          {t("timeout", { ns: "common" })}
                        </button>
                      )}
                      {canTimeout && selectedTimeoutExpiresAt && (
                        <button
                          onClick={handleRemoveTimeout}
                          className="settings-btn settings-btn-danger"
                        >
                          {t("removeTimeout", { ns: "common" })}
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="no-channel">
                {t("noMemberSelected")}
              </div>
            )}
          </>
        )}

        {/* ─── Bans Tab — Right Panel ─── */}
        {activeTab === "bans" && (
          <>
            {selectedBan ? (
              <div className="channel-perm-section">
                <div className="member-settings-detail-header">
                  <div className="member-settings-avatar member-settings-avatar-lg member-settings-avatar-banned">
                    <span className="member-settings-avatar-fallback">
                      {selectedBan.username.charAt(0).toUpperCase()}
                    </span>
                  </div>
                  <div>
                    <div className="member-settings-detail-name member-settings-name-banned">
                      {selectedBan.username}
                    </div>
                    <div className="member-settings-detail-username">
                      {t("bannedOn", { date: formatBanDate(selectedBan.created_at) })}
                    </div>
                  </div>
                </div>

                <div className="settings-field">
                  <label className="settings-label">{t("banReason")}</label>
                  <p className="ban-detail-value">
                    {selectedBan.reason || t("noReasonProvided")}
                  </p>
                </div>

                <div className="settings-field">
                  <label className="settings-label">{t("bannedBy")}</label>
                  <p className="ban-detail-value">
                    {selectedBan.banned_by}
                  </p>
                </div>

                <div className="settings-field">
                  <label className="settings-label">
                    {selectedBan.expires_at ? t("banExpiresAt") : t("banPermanentLabel")}
                  </label>
                  <p className="ban-detail-value">
                    {selectedBan.expires_at
                      ? formatFullDateTime(selectedBan.expires_at, i18n.language)
                      : "—"}
                  </p>
                  {selectedBan.expires_at && (
                    <p className="ban-detail-expiry">
                      {t("banExpiresIn", {
                        rel: formatRelativeFuture(selectedBan.expires_at, i18n.language),
                      })}
                    </p>
                  )}
                </div>

                <div className="member-settings-actions">
                  <button
                    onClick={handleUnban}
                    className="settings-btn"
                  >
                    {t("unban")}
                  </button>
                </div>
              </div>
            ) : (
              <div className="no-channel">
                {t("selectBannedMember")}
              </div>
            )}
          </>
        )}
      </div>

      {showTimeoutPicker && selectedMember &&
        createPortal(
          <ModDurationPicker
            title={t("timeoutTitle", { ns: "common" })}
            subtitle={t("timeoutForUser", {
              ns: "common",
              username: selectedMember.display_name || selectedMember.username,
            })}
            variant="timeout"
            hint={t("timeoutPickerHint", { ns: "common" })}
            presets={TIMEOUT_PRESETS}
            onPick={handleTimeoutPick}
            onCancel={() => setShowTimeoutPicker(false)}
          />,
          document.body
        )}
    </div>
  );
}

export default MembersSettings;
