/** MemberCard — Unified user profile popover. Works in server context (with roles/mod)
 *  and global context (DM sidebar, friend list — no server-specific sections). */

import { useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { MemberWithRoles, PublicUser } from "../../types";
import RoleEditorPopup from "./RoleEditorPopup";
import BadgeAssignModal from "./BadgeAssignModal";
import MemberCardIdentity from "./memberCard/MemberCardIdentity";
import MemberCardSelfStatus from "./memberCard/MemberCardSelfStatus";
import MemberCardActions from "./memberCard/MemberCardActions";
import MemberCardModeration from "./memberCard/MemberCardModeration";
import { useUserBadges } from "../../hooks/useUserBadges";
import { useAuthStore } from "../../stores/authStore";
import { useVoiceStore } from "../../stores/voiceStore";
import { useActiveMembers, useMemberTimeout } from "../../stores/memberStore";
import { useDMStore } from "../../stores/dmStore";
import { useUIStore } from "../../stores/uiStore";
import { useFriendStore } from "../../stores/friendStore";
import { useBlockStore } from "../../stores/blockStore";
import { useP2PCallStore } from "../../stores/p2pCallStore";
import { useConfirm } from "../../hooks/useConfirm";
import { useAnchoredCard } from "../../hooks/useAnchoredCard";
import { hasPermission, Permissions } from "../../utils/permissions";
import * as memberApi from "../../api/members";
import { useServerStore } from "../../stores/serverStore";
import ReportModal from "../shared/ReportModal";
import ModDurationPicker from "./ModDurationPicker";
import { TIMEOUT_PRESETS, TEMPBAN_PRESETS } from "./modDurationPresets";
import { formatDate } from "../../utils/dateFormat";
import { showApiError } from "../../utils/apiError";

type MemberCardProps = {
  member?: MemberWithRoles;
  user?: PublicUser;
  position: { top: number; left: number };
  onClose: () => void;
};

function MemberCard({ member, user: userProp, position, onClose }: MemberCardProps) {
  const { t } = useTranslation("common");
  const confirm = useConfirm();
  const currentUser = useAuthStore((s) => s.user);

  // Derive common fields from member or user prop. `target` may be null
  // (caller fed neither a member nor a user prop); we still call every
  // hook below with safe-fallback inputs so React's hook-order
  // invariant holds, then early-return AFTER the hook block.
  const target = member ?? userProp;
  const userId = target?.id ?? "";
  const username = target?.username ?? "";
  const displayName = target?.display_name;
  const avatarUrl = target?.avatar_url;
  const customStatus = target?.custom_status;
  const createdAt = target?.created_at ?? "";
  const isServerContext = !!member;

  // Active moderator timeout (if any). Falls back to the inline field
  // on the freshly-fetched member object so the banner appears even
  // before the first WS event arrives. Subscribes to the store so the
  // banner disappears live when handleMemberTimeoutRemove fires.
  const activeServerId = useServerStore((s) => s.activeServerId);
  const storeTimeout = useMemberTimeout(activeServerId, userId);
  const timeoutExpiresAt =
    storeTimeout?.expires_at ?? (isServerContext ? member?.timeout_expires_at ?? undefined : undefined);

  const activeMembers = useActiveMembers();
  const currentMember = activeMembers.find((m) => m.id === currentUser?.id);
  const myPerms = currentMember?.effective_permissions ?? 0;

  const friends = useFriendStore((s) => s.friends);
  const incoming = useFriendStore((s) => s.incoming);
  const outgoing = useFriendStore((s) => s.outgoing);

  const [showRoleEditor, setShowRoleEditor] = useState(false);
  const [showBadgeAssign, setShowBadgeAssign] = useState(false);
  const [showReport, setShowReport] = useState(false);

  const isBlocked = useBlockStore((s) => s.isBlocked)(userId);
  const blockUser = useBlockStore((s) => s.blockUser);
  const unblockUser = useBlockStore((s) => s.unblockUser);

  const userBadges = useUserBadges(userId);

  const isMe = currentUser?.id === userId;
  const manualStatus = useAuthStore((s) => s.manualStatus);
  const setManualStatus = useAuthStore((s) => s.setManualStatus);

  function handleSetStatus(status: "online" | "idle" | "dnd" | "offline") {
    setManualStatus(status);
    useVoiceStore.getState()._wsSend?.("presence_update", { status, is_auto: false });
    onClose();
  }
  const canKick = isServerContext && !isMe && hasPermission(myPerms, Permissions.KickMembers);
  const canBan = isServerContext && !isMe && hasPermission(myPerms, Permissions.BanMembers);
  const canTimeout = isServerContext && !isMe && hasPermission(myPerms, Permissions.TimeoutMembers);
  const canManageRoles = isServerContext && !isMe && hasPermission(myPerms, Permissions.ManageRoles);
  // Self-rename is always allowed; renaming OTHERS needs ManageNicknames.
  const canSetOwnNickname = isServerContext && isMe;
  const canSetOtherNickname = isServerContext && !isMe && hasPermission(myPerms, Permissions.ManageNicknames);
  const canEditNickname = canSetOwnNickname || canSetOtherNickname;
  const isBadgeAdmin = currentUser?.is_platform_admin === true;
  const hasModActions = canKick || canBan || canTimeout || canManageRoles;
  // Duration picker state — null when closed; "timeout" or "tempban" picks
  // which preset list + which API to hit on selection.
  const [pickerMode, setPickerMode] = useState<"timeout" | "tempban" | null>(null);
  // Nickname editor state — null when closed; otherwise the in-flight
  // input value (initialised from the current nickname or display name).
  const [nicknameDraft, setNicknameDraft] = useState<string | null>(null);

  const isFriend = friends.some((f) => f.user_id === userId);
  const outReq = outgoing.find((r) => r.user_id === userId);
  const inReq = incoming.find((r) => r.user_id === userId);

  // Anchored-card plumbing: viewport-clamped position + click-outside
  // dismissal. Any open child modal suppresses click-outside so
  // interacting with it doesn't close the card underneath.
  const { cardRef, adjustedPos } = useAnchoredCard(
    position,
    onClose,
    showBadgeAssign || showRoleEditor || showReport || pickerMode !== null
  );

  // Early return AFTER every hook above — keeps React's hook call order
  // stable across renders. If we early-returned before the hooks (the
  // target=null path), React would lose its hook-list alignment the
  // moment target flipped to non-null and crash with "rendered more
  // hooks than during the previous render".
  if (!target) return null;

  const sortedRoles = member ? [...member.roles].sort((a, b) => b.position - a.position) : [];
  const joinDate = formatDate(createdAt);

  async function handleKick() {
    const ok = await confirm({
      message: t("confirmKick", { username }),
      confirmLabel: t("kick"),
      danger: true,
    });
    if (!ok) return;
    const serverId = useServerStore.getState().activeServerId;
    if (!serverId) return;
    const res = await memberApi.kickMember(serverId, userId);
    if (!res.success) {
      showApiError(res, { fallbackKey: "common:kickError" });
      return;
    }
    onClose();
  }

  async function handleBan() {
    const ok = await confirm({
      message: t("confirmBan", { username }),
      confirmLabel: t("ban"),
      danger: true,
    });
    if (!ok) return;
    const serverId = useServerStore.getState().activeServerId;
    if (!serverId) return;
    const res = await memberApi.banMember(serverId, userId, "");
    if (!res.success) {
      showApiError(res, { fallbackKey: "common:banError" });
      return;
    }
    onClose();
  }

  async function handleTimeoutPick(seconds: number) {
    setPickerMode(null);
    const serverId = useServerStore.getState().activeServerId;
    if (!serverId) return;
    const res = await memberApi.timeoutMember(serverId, userId, seconds, "");
    if (!res.success) {
      // Don't close the popover on failure (e.g. 403) — closing made the
      // mod think the timeout applied when it silently didn't.
      showApiError(res, { fallbackKey: "common:timeoutError" });
      return;
    }
    onClose();
  }

  // One-click "Susturmayı kaldır" — matches Discord's direct moderation
  // UX (no confirmation dialog). The mod can re-timeout with one click
  // if they remove by mistake, so the reversal cost is low.
  async function handleRemoveTimeout() {
    const serverId = useServerStore.getState().activeServerId;
    if (!serverId) return;
    const res = await memberApi.removeTimeout(serverId, userId);
    if (!res.success) {
      showApiError(res, { fallbackKey: "common:removeTimeoutError" });
      return;
    }
    // No onClose here — the banner disappears via WS event and the mod
    // may want to perform follow-up actions (kick / ban) without
    // reopening the popover.
  }

  async function handleTempBanPick(seconds: number) {
    setPickerMode(null);
    const serverId = useServerStore.getState().activeServerId;
    if (!serverId) return;
    const res = await memberApi.banMember(serverId, userId, "", seconds);
    if (!res.success) {
      showApiError(res, { fallbackKey: "common:tempBanError" });
      return;
    }
    onClose();
  }

  function openNicknameEditor() {
    // Pre-fill with the current nickname (if any), then display name,
    // then username — so the textbox shows whatever the user is
    // already known by, and they can edit incrementally.
    setNicknameDraft(member?.nickname ?? displayName ?? username ?? "");
  }

  async function handleSaveNickname() {
    if (nicknameDraft === null) return;
    const serverId = useServerStore.getState().activeServerId;
    if (!serverId) return;
    const trimmed = nicknameDraft.trim();
    setNicknameDraft(null);
    await memberApi.setMemberNickname(serverId, userId, trimmed);
  }

  async function handleSendMessage() {
    const channelId = await useDMStore.getState().createOrGetChannel(userId);
    if (channelId) {
      useUIStore.getState().openTab(channelId, "dm", displayName ?? username);
    }
    onClose();
  }

  function handleVoiceCall() {
    useP2PCallStore.getState().initiateCall(userId, "voice");
    onClose();
  }

  function handleVideoCall() {
    useP2PCallStore.getState().initiateCall(userId, "video");
    onClose();
  }

  async function handleFriendAction() {
    if (isFriend) {
      const ok = await confirm({
        message: t("confirmRemoveFriend", { username }),
        confirmLabel: t("removeFriend"),
        danger: true,
      });
      if (ok) await useFriendStore.getState().removeFriend(userId);
    } else if (outReq) {
      await useFriendStore.getState().declineRequest(outReq.id);
    } else if (inReq) {
      await useFriendStore.getState().acceptRequest(inReq.id);
    } else {
      await useFriendStore.getState().sendRequest(username);
    }
  }

  function getFriendLabel(): string {
    if (isFriend) return t("removeFriend");
    if (outReq) return t("cancelRequest");
    if (inReq) return t("acceptRequest");
    return t("addFriend");
  }

  return createPortal(
    <>
      <div className="member-card-backdrop" onClick={onClose} />

      <div
        ref={cardRef}
        className="member-card"
        style={{ top: adjustedPos.top, left: adjustedPos.left }}
      >
        <MemberCardIdentity
          member={member}
          username={username}
          displayName={displayName}
          avatarUrl={avatarUrl}
          customStatus={customStatus}
          userBadges={userBadges}
          joinDate={joinDate}
          canEditNickname={canEditNickname}
          nicknameDraft={nicknameDraft}
          setNicknameDraft={setNicknameDraft}
          openNicknameEditor={openNicknameEditor}
          handleSaveNickname={handleSaveNickname}
          isServerContext={isServerContext}
          timeoutExpiresAt={timeoutExpiresAt}
          canTimeout={canTimeout}
          handleRemoveTimeout={handleRemoveTimeout}
          sortedRoles={sortedRoles}
          onClose={onClose}
        >
          {/* Self status picker */}
          {isMe && (
            <MemberCardSelfStatus
              manualStatus={manualStatus}
              handleSetStatus={handleSetStatus}
            />
          )}

          <MemberCardActions
            isMe={isMe}
            isBadgeAdmin={isBadgeAdmin}
            isFriend={isFriend}
            isBlocked={isBlocked}
            userId={userId}
            username={username}
            handleSendMessage={handleSendMessage}
            handleVoiceCall={handleVoiceCall}
            handleVideoCall={handleVideoCall}
            handleFriendAction={handleFriendAction}
            getFriendLabel={getFriendLabel}
            blockUser={blockUser}
            unblockUser={unblockUser}
            confirm={confirm}
            setShowBadgeAssign={setShowBadgeAssign}
            setShowReport={setShowReport}
          />

          {/* Moderation (server context only) */}
          {hasModActions && (
            <MemberCardModeration
              canKick={canKick}
              canTimeout={canTimeout}
              canBan={canBan}
              canManageRoles={canManageRoles}
              handleKick={handleKick}
              handleBan={handleBan}
              setPickerMode={setPickerMode}
              setShowRoleEditor={setShowRoleEditor}
            />
          )}
        </MemberCardIdentity>
      </div>

      {showRoleEditor && member && (
        <RoleEditorPopup
          member={member}
          position={{ top: position.top + 100, left: position.left }}
          onClose={() => setShowRoleEditor(false)}
        />
      )}

      {showBadgeAssign && (
        <BadgeAssignModal
          member={member ?? { id: userId, username, display_name: displayName, avatar_url: avatarUrl, custom_status: customStatus, created_at: createdAt, status: "online", roles: [], effective_permissions: 0 } as MemberWithRoles}
          onClose={() => setShowBadgeAssign(false)}
        />
      )}

      {showReport && (
        <ReportModal
          userId={userId}
          username={displayName ?? username}
          onClose={() => setShowReport(false)}
        />
      )}

      {pickerMode === "timeout" && (
        <ModDurationPicker
          title={t("timeoutTitle")}
          subtitle={t("timeoutForUser", { username: displayName ?? username })}
          variant="timeout"
          hint={t("timeoutPickerHint")}
          presets={TIMEOUT_PRESETS}
          onPick={handleTimeoutPick}
          onCancel={() => setPickerMode(null)}
        />
      )}
      {pickerMode === "tempban" && (
        <ModDurationPicker
          title={t("tempBanTitle")}
          subtitle={t("timeoutForUser", { username: displayName ?? username })}
          variant="ban"
          hint={t("tempBanPickerWarning")}
          presets={TEMPBAN_PRESETS}
          onPick={handleTempBanPick}
          onCancel={() => setPickerMode(null)}
        />
      )}
    </>,
    document.body
  );
}

export default MemberCard;
