/** MemberItem — Single member row in the member list with context menu and profile card. */

import { useState, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { createPortal } from "react-dom";
import Avatar from "../shared/Avatar";
import ContextMenu from "../shared/ContextMenu";
import { useContextMenu } from "../../hooks/useContextMenu";
import type { ContextMenuItem } from "../../hooks/useContextMenu";
import { copyToClipboard } from "../../utils/constants";
import { useAuthStore } from "../../stores/authStore";
import { useActiveMembers, useMemberTimeout } from "../../stores/memberStore";
import { useDMStore } from "../../stores/dmStore";
import { useUIStore } from "../../stores/uiStore";
import { useFriendStore } from "../../stores/friendStore";
import { useP2PCallStore } from "../../stores/p2pCallStore";
import { useConfirm } from "../../hooks/useConfirm";
import { hasPermission, Permissions } from "../../utils/permissions";
import * as memberApi from "../../api/members";
import { useServerStore } from "../../stores/serverStore";
import type { MemberWithRoles } from "../../types";
import MemberCard from "./MemberCard";
import RoleEditorPopup from "./RoleEditorPopup";
import BadgeAssignModal from "./BadgeAssignModal";
import { formatFullDateTime, lastSeenLabel } from "../../utils/dateFormat";

/** The user ID that can assign badges to other users. */
const BADGE_ADMIN_USER_ID = "95a8b295072f98a5";

type MemberItemProps = {
  member: MemberWithRoles;
  isOnline: boolean;
  /** Ticking "now" snapshot (from MemberList's single useNowTick) used to
   *  render a live "last seen X ago" label for offline members. Only
   *  needed when isOnline is false. */
  nowMs?: number;
};

function getHighestRole(member: MemberWithRoles) {
  if (member.roles.length === 0) return null;
  return member.roles.reduce((highest, role) =>
    role.position > highest.position ? role : highest
  );
}

function getRoleType(member: MemberWithRoles): "admin" | "mod" | null {
  const highest = getHighestRole(member);
  if (!highest) return null;

  const name = highest.name.toLowerCase();
  if (name.includes("admin") || name.includes("owner")) return "admin";
  if (name.includes("mod")) return "mod";
  return null;
}

function getStatusClass(status: string): string {
  switch (status) {
    case "online":
      return "status-on";
    case "idle":
      return "status-idle";
    case "dnd":
      return "status-dnd";
    default:
      return "status-off";
  }
}

/**
 * Top-level row class derived from presence status.
 * CSS uses this to colour and glow the username (.member-online .member-name etc.)
 * so the whole row reads at a glance: green = online, amber = idle, red = DnD.
 */
function getRowStatusClass(status: string, isOnline: boolean): string {
  if (!isOnline) return "member-offline";
  switch (status) {
    case "online":
      return "member-online";
    case "idle":
      return "member-idle";
    case "dnd":
      return "member-dnd";
    default:
      return "member-offline";
  }
}

function MemberItem({ member, isOnline, nowMs }: MemberItemProps) {
  const { t, i18n } = useTranslation("common");
  const { menuState, openMenu, closeMenu } = useContextMenu();
  const confirm = useConfirm();
  const currentUser = useAuthStore((s) => s.user);
  const members = useActiveMembers();
  const friends = useFriendStore((s) => s.friends);
  const incoming = useFriendStore((s) => s.incoming);
  const outgoing = useFriendStore((s) => s.outgoing);
  // Subscribes to the timeout slice so the badge appears/disappears
  // live as the store handles member_timeout(_remove) events.
  const activeServerId = useServerStore((s) => s.activeServerId);
  const timeout = useMemberTimeout(activeServerId, member.id);
  const timeoutExpiresAt = timeout?.expires_at ?? member.timeout_expires_at ?? undefined;

  const [showCard, setShowCard] = useState(false);
  const [cardPos, setCardPos] = useState({ top: 0, left: 0 });
  const [showRoleEditor, setShowRoleEditor] = useState(false);
  const [roleEditorPos, setRoleEditorPos] = useState({ top: 0, left: 0 });
  const [showBadgeAssign, setShowBadgeAssign] = useState(false);
  const itemRef = useRef<HTMLDivElement>(null);
  const roleType = getRoleType(member);
  const displayName = member.display_name ?? member.username;

  // Graduated "last seen X ago" label for offline members — replaces the
  // custom-status slot since a stale status is less useful than knowing
  // when they were last around. Only computed when we have a valid
  // last_seen_at and the live "now" tick from MemberList.
  let lastSeenText: string | null = null;
  if (!isOnline && member.last_seen_at && typeof nowMs === "number") {
    const lastSeenMs = Date.parse(member.last_seen_at);
    if (!Number.isNaN(lastSeenMs)) {
      const label = lastSeenLabel(lastSeenMs, nowMs, i18n.language);
      lastSeenText = t(label.key, label.values);
    }
  }

  /** Right-click context menu */
  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      const isSelf = currentUser?.id === member.id;
      const currentMember = members.find((m) => m.id === currentUser?.id);
      const myPerms = currentMember?.effective_permissions ?? 0;
      const canKick = hasPermission(myPerms, Permissions.KickMembers);
      const canBan = hasPermission(myPerms, Permissions.BanMembers);
      const canManageRoles = hasPermission(myPerms, Permissions.ManageRoles);

      const items: ContextMenuItem[] = [];

      // ─── Send Message (DM) ───
      if (!isSelf) {
        items.push({
          label: t("sendMessage"),
          onClick: async () => {
            const channelId = await useDMStore.getState().createOrGetChannel(member.id);
            if (channelId) {
              useDMStore.getState().selectDM(channelId);
              useUIStore.getState().openTab(channelId, "dm", member.display_name ?? member.username);
            }
          },
        });
      }

      // ─── Call (P2P audio) ───
      if (!isSelf) {
        items.push({
          label: t("call"),
          onClick: async () => {
            const channelId = await useDMStore.getState().createOrGetChannel(member.id);
            if (channelId) {
              useDMStore.getState().selectDM(channelId);
              useUIStore.getState().openTab(channelId, "dm", member.display_name ?? member.username);
            }
            useP2PCallStore.getState().initiateCall(member.id, "voice");
          },
        });
      }

      // ─── Friend action (dynamic based on current state) ───
      if (!isSelf) {
        const isFriend = friends.some((f) => f.user_id === member.id);
        const outReq = outgoing.find((r) => r.user_id === member.id);
        const inReq = incoming.find((r) => r.user_id === member.id);

        if (isFriend) {
          items.push({
            label: t("removeFriend"),
            onClick: async () => {
              const ok = await confirm({
                message: t("confirmRemoveFriend", { username: member.username }),
                confirmLabel: t("removeFriend"),
                danger: true,
              });
              if (ok) await useFriendStore.getState().removeFriend(member.id);
            },
            danger: true,
          });
        } else if (outReq) {
          items.push({
            label: t("cancelRequest"),
            onClick: async () => {
              await useFriendStore.getState().declineRequest(outReq.id);
            },
          });
        } else if (inReq) {
          items.push({
            label: t("acceptRequest"),
            onClick: async () => {
              await useFriendStore.getState().acceptRequest(inReq.id);
            },
          });
        } else {
          items.push({
            label: t("addFriend"),
            onClick: async () => {
              await useFriendStore.getState().sendRequest(member.username);
            },
          });
        }
      }

      // ─── Copy ID ───
      items.push({
        label: "Copy ID",
        onClick: () => copyToClipboard(member.id),
        separator: !isSelf,
      });

      // ─── Assign Badge (badge admin only, including self) ───
      if (currentUser?.id === BADGE_ADMIN_USER_ID) {
        items.push({
          label: t("assignBadge"),
          onClick: () => setShowBadgeAssign(true),
        });
      }

      // ─── Edit Roles ───
      if (canManageRoles && !isSelf) {
        items.push({
          label: t("editRoles"),
          onClick: () => {
            setRoleEditorPos({ top: e.clientY, left: e.clientX });
            setShowRoleEditor(true);
          },
          separator: true,
        });
      }

      // ─── Kick ───
      if (canKick && !isSelf) {
        items.push({
          label: t("kick"),
          onClick: async () => {
            const ok = await confirm({
              message: t("confirmKick", { username: member.username }),
              confirmLabel: t("kick"),
              danger: true,
            });
            if (ok) {
              const serverId = useServerStore.getState().activeServerId;
              if (serverId) await memberApi.kickMember(serverId, member.id);
            }
          },
          danger: true,
          separator: !canManageRoles,
        });
      }

      // ─── Ban ───
      if (canBan && !isSelf) {
        items.push({
          label: t("ban"),
          onClick: async () => {
            const ok = await confirm({
              message: t("confirmBan", { username: member.username }),
              confirmLabel: t("ban"),
              danger: true,
            });
            if (ok) {
              const serverId = useServerStore.getState().activeServerId;
              if (serverId) await memberApi.banMember(serverId, member.id, "");
            }
          },
          danger: true,
        });
      }

      openMenu(e, items);
    },
    [currentUser, member, members, friends, incoming, outgoing, openMenu, confirm, t]
  );

  const handleClick = useCallback(() => {
    if (showCard) {
      setShowCard(false);
      return;
    }

    if (itemRef.current) {
      const rect = itemRef.current.getBoundingClientRect();
      const cardWidth = 340;
      const gap = 8;

      let top = rect.top;
      const cardEstimatedHeight = 350;
      if (top + cardEstimatedHeight > window.innerHeight) {
        top = window.innerHeight - cardEstimatedHeight - 16;
      }
      if (top < 8) top = 8;

      setCardPos({
        top,
        left: rect.left - cardWidth - gap,
      });
    }

    setShowCard(true);
  }, [showCard]);

  return (
    <>
      <div
        ref={itemRef}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        className={`member ${getRowStatusClass(member.status, isOnline)}${!isOnline ? " offline" : ""}`}
      >
        {/* Avatar + status dot */}
        <div className="member-av-wrap">
          <Avatar
            name={member.username}
            role={roleType}
            avatarUrl={member.avatar_url ?? undefined}
            size={32}
          />
          <span className={`member-status ${getStatusClass(member.status)}`} />
        </div>

        {/* Name + Activity. Username colour comes from the row's status
            class (.member-online → green, .member-idle → amber, etc.) so
            we no longer apply role colour inline — presence is a more
            useful at-a-glance signal in the member list, and CSS classes
            cleanly carry the glow/shadow that goes with each colour. */}
        <div className="member-info">
          <span className="member-name">
            {displayName}
            {timeoutExpiresAt && (
              <span
                className="member-timeout-badge"
                title={`${t("timeoutActive")} — ${formatFullDateTime(timeoutExpiresAt, i18n.language)}`}
                aria-label={t("timeoutActive")}
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <circle cx="12" cy="12" r="10" />
                  <polyline points="12 6 12 12 16 14" />
                </svg>
              </span>
            )}
          </span>

          {lastSeenText ? (
            <span className="member-activity">{lastSeenText}</span>
          ) : (
            member.custom_status && (
              <span className="member-activity">
                {member.custom_status}
              </span>
            )
          )}
        </div>
      </div>

      {/* Context Menu */}
      <ContextMenu state={menuState} onClose={closeMenu} />

      {/* MemberCard (portal) */}
      {showCard &&
        createPortal(
          <MemberCard
            member={member}
            position={cardPos}
            onClose={() => setShowCard(false)}
          />,
          document.body
        )}

      {/* RoleEditorPopup */}
      {showRoleEditor && (
        <RoleEditorPopup
          member={member}
          position={roleEditorPos}
          onClose={() => setShowRoleEditor(false)}
        />
      )}

      {/* Badge Assign Modal (placeholder) */}
      {showBadgeAssign && (
        <BadgeAssignModal
          member={member}
          onClose={() => setShowBadgeAssign(false)}
        />
      )}
    </>
  );
}

export default MemberItem;
