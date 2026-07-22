/** AdminUserList — Platform admin user management table (sortable, filterable, resizable columns). */

import { useEffect, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useToastStore } from "../../stores/toastStore";
import { showApiError } from "../../utils/apiError";
import { useAuthStore } from "../../stores/authStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useDMStore } from "../../stores/dmStore";
import { useUIStore } from "../../stores/uiStore";
import { listAdminUsers, platformBanUser, platformUnbanUser, hardDeleteUser, setUserPlatformAdmin } from "../../api/admin";
import { useContextMenu } from "../../hooks/useContextMenu";
import { useConfirm } from "../../hooks/useConfirm";
import ContextMenu from "../shared/ContextMenu";
import PlatformBanDialog from "./PlatformBanDialog";
import PlatformActionDialog from "./PlatformActionDialog";
import BadgeAssignModal from "../members/BadgeAssignModal";
import type { AdminUserListItem } from "../../types";
import { resolveAssetUrl } from "../../utils/constants";
import type { ContextMenuItem } from "../../hooks/useContextMenu";
import AdminTable from "./AdminTable";
import type { ColumnDef } from "./adminTableTypes";
import { useNowTick } from "../../hooks/useNowTick";
import { useTableFilter } from "../../hooks/useTableFilter";
import { useTableSort } from "../../hooks/useTableSort";
import { useColumnResize } from "../../hooks/useColumnResize";
import { parseUTC, formatStorage, formatDateTime, formatRelativeTime as relativeTime } from "../../utils/adminFormat";

const BADGE_ADMIN_USER_ID = "95a8b295072f98a5";

// ─── Column Definition ───

type SortKey =
  | "username"
  | "display_name"
  | "id"
  | "created_at"
  | "status"
  | "is_platform_admin"
  | "last_activity"
  | "message_count"
  | "storage_mb"
  | "owned_self_servers"
  | "owned_mqvi_servers"
  | "member_server_count"
  | "ban_count";

const COLUMNS: ColumnDef<SortKey>[] = [
  { key: "username", labelKey: "platformUserUsername", defaultWidth: 150, minWidth: 100, sortable: true, align: "left" },
  { key: "display_name", labelKey: "platformUserDisplayName", defaultWidth: 140, minWidth: 100, sortable: true, align: "left" },
  { key: "id", labelKey: "platformUserID", defaultWidth: 110, minWidth: 80, sortable: false, align: "left" },
  { key: "created_at", labelKey: "platformUserJoined", defaultWidth: 155, minWidth: 120, sortable: true, align: "left" },
  { key: "status", labelKey: "platformUserStatus", defaultWidth: 90, minWidth: 70, sortable: true, align: "left" },
  { key: "is_platform_admin", labelKey: "platformUserAdmin", defaultWidth: 80, minWidth: 60, sortable: true, align: "center" },
  { key: "last_activity", labelKey: "platformUserLastActivity", defaultWidth: 110, minWidth: 80, sortable: true, align: "left" },
  { key: "message_count", labelKey: "platformUserMessages", defaultWidth: 90, minWidth: 70, sortable: true, align: "right" },
  { key: "storage_mb", labelKey: "platformUserStorage", defaultWidth: 85, minWidth: 65, sortable: true, align: "right" },
  { key: "owned_self_servers", labelKey: "platformUserSelfServers", defaultWidth: 100, minWidth: 70, sortable: true, align: "right" },
  { key: "owned_mqvi_servers", labelKey: "platformUserMqviServers", defaultWidth: 100, minWidth: 70, sortable: true, align: "right" },
  { key: "member_server_count", labelKey: "platformUserMemberServers", defaultWidth: 100, minWidth: 70, sortable: true, align: "right" },
  { key: "ban_count", labelKey: "platformUserBans", defaultWidth: 70, minWidth: 55, sortable: true, align: "right" },
];

/** Search predicate — username, id, or display name (case-insensitive). */
function matchesUser(u: AdminUserListItem, q: string): boolean {
  return (
    u.username.toLowerCase().includes(q) ||
    u.id.toLowerCase().includes(q) ||
    (u.display_name?.toLowerCase().includes(q) ?? false)
  );
}

// ─── Sort comparator ───

function compareSortValue(
  a: AdminUserListItem,
  b: AdminUserListItem,
  key: SortKey,
  dir: "asc" | "desc",
): number {
  let result = 0;

  switch (key) {
    case "username":
      result = a.username.localeCompare(b.username);
      break;
    case "display_name": {
      const aName = a.display_name ?? "";
      const bName = b.display_name ?? "";
      result = aName.localeCompare(bName);
      break;
    }
    case "created_at":
      result = new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
      break;
    case "status":
      result = a.status.localeCompare(b.status);
      break;
    case "is_platform_admin":
      result = (a.is_platform_admin ? 1 : 0) - (b.is_platform_admin ? 1 : 0);
      break;
    case "last_activity": {
      const aTime = a.last_activity ? parseUTC(a.last_activity) : 0;
      const bTime = b.last_activity ? parseUTC(b.last_activity) : 0;
      result = aTime - bTime;
      break;
    }
    case "message_count":
      result = a.message_count - b.message_count;
      break;
    case "storage_mb":
      result = a.storage_mb - b.storage_mb;
      break;
    case "owned_self_servers":
      result = a.owned_self_servers - b.owned_self_servers;
      break;
    case "owned_mqvi_servers":
      result = a.owned_mqvi_servers - b.owned_mqvi_servers;
      break;
    case "member_server_count":
      result = a.member_server_count - b.member_server_count;
      break;
    case "ban_count":
      result = a.ban_count - b.ban_count;
      break;
    default:
      result = 0;
  }

  return dir === "desc" ? -result : result;
}

// ─── Component ───

function AdminUserList() {
  const { t } = useTranslation("settings");
  const { t: tCommon } = useTranslation("common");
  const addToast = useToastStore((s) => s.addToast);
  const currentUser = useAuthStore((s) => s.user);
  const { menuState, openMenu, closeMenu } = useContextMenu();
  const confirm = useConfirm();
  const isBadgeAdmin = currentUser?.id === BADGE_ADMIN_USER_ID;

  // ─── Data state ───
  const [users, setUsers] = useState<AdminUserListItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // ─── Ban dialog state ───
  const [banTarget, setBanTarget] = useState<AdminUserListItem | null>(null);

  // ─── Badge assign state ───
  const [badgeTarget, setBadgeTarget] = useState<AdminUserListItem | null>(null);

  // ─── Delete dialog state ───
  const [deleteTarget, setDeleteTarget] = useState<AdminUserListItem | null>(null);

  // ─── Table state (search + shared sort/filter/resize/now hooks) ───
  const [searchQuery, setSearchQuery] = useState("");
  const nowMs = useNowTick();
  const { columnWidths, handleResizeStart } = useColumnResize(COLUMNS);
  const filteredUsers = useTableFilter(users, searchQuery, matchesUser);
  const { sortKey, sortDir, sortedRows, handleSort } = useTableSort(
    filteredUsers,
    COLUMNS,
    compareSortValue,
    "username",
    "asc",
  );

  // ─── Fetch ───
  useEffect(() => {
    async function load() {
      setIsLoading(true);
      const res = await listAdminUsers();
      if (res.success && res.data) {
        setUsers(res.data);
      } else {
        showApiError(res, { fallbackKey: "settings:platformUserLoadError" });
      }
      setIsLoading(false);
    }
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Context Menu ───

  const refetchUsers = useCallback(async () => {
    const res = await listAdminUsers();
    if (res.success && res.data) {
      setUsers(res.data);
    }
  }, []);

  function buildContextItems(user: AdminUserListItem): ContextMenuItem[] {
    const isMe = user.id === currentUser?.id;
    const items: ContextMenuItem[] = [];

    if (!isMe) {
      items.push({
        label: t("platformUserSendDM"),
        onClick: () => handleSendDM(user),
      });
    }

    if (isBadgeAdmin) {
      items.push({
        label: tCommon("assignBadge"),
        separator: items.length > 0,
        onClick: () => setBadgeTarget(user),
      });
    }

    if (!isMe) {
      items.push({
        label: user.is_platform_admin
          ? t("platformUserRemoveAdmin")
          : t("platformUserMakeAdmin"),
        separator: items.length > 0,
        onClick: () => handleAdminToggle(user),
      });
    }

    if (!isMe && !user.is_platform_banned) {
      items.push({
        label: t("platformUserBan"),
        danger: true,
        separator: items.length > 0,
        onClick: () => setBanTarget(user),
      });
    }

    if (!isMe && user.is_platform_banned) {
      items.push({
        label: t("platformUserUnban"),
        separator: items.length > 0,
        onClick: () => handleUnban(user),
      });
    }

    if (!isMe) {
      items.push({
        label: t("platformUserDelete"),
        danger: true,
        separator: items.length > 0 && !items[items.length - 1]?.separator,
        onClick: () => setDeleteTarget(user),
      });
    }

    return items;
  }

  async function handleSendDM(user: AdminUserListItem) {
    const channelId = await useDMStore.getState().createOrGetChannel(user.id);
    if (channelId) {
      const displayName = user.display_name ?? user.username;
      useUIStore.getState().openTab(channelId, "dm", displayName);
      useSettingsStore.getState().closeSettings();
    }
  }

  async function handleBanConfirm(reason: string, deleteMessages: boolean) {
    if (!banTarget) return;
    const targetId = banTarget.id;
    const targetName = banTarget.username;
    setBanTarget(null);

    const res = await platformBanUser(targetId, { reason, delete_messages: deleteMessages });
    if (res.success) {
      addToast("success", t("platformBanSuccess", { username: targetName }));
      await refetchUsers();
    } else {
      showApiError(res, { fallbackKey: "settings:platformBanError" });
    }
  }

  async function handleUnban(user: AdminUserListItem) {
    const ok = await confirm({
      message: t("platformUnbanConfirm", { username: user.username }),
    });
    if (!ok) return;

    const res = await platformUnbanUser(user.id);
    if (res.success) {
      addToast("success", t("platformUnbanSuccess", { username: user.username }));
      await refetchUsers();
    } else {
      showApiError(res, { fallbackKey: "settings:platformUnbanError" });
    }
  }

  async function handleAdminToggle(user: AdminUserListItem) {
    const willBeAdmin = !user.is_platform_admin;
    const message = willBeAdmin
      ? t("platformMakeAdminConfirm", { username: user.username })
      : t("platformRemoveAdminConfirm", { username: user.username });

    const ok = await confirm({ message, danger: !willBeAdmin });
    if (!ok) return;

    const res = await setUserPlatformAdmin(user.id, { is_admin: willBeAdmin });
    if (res.success) {
      addToast("success", t("platformAdminSuccess"));
      await refetchUsers();
    } else {
      showApiError(res, { fallbackKey: "settings:platformAdminError" });
    }
  }

  async function handleDeleteConfirm(reason: string) {
    if (!deleteTarget) return;
    const targetId = deleteTarget.id;
    const targetName = deleteTarget.username;
    setDeleteTarget(null);

    const res = await hardDeleteUser(targetId, reason ? { reason } : undefined);
    if (res.success) {
      addToast("success", t("platformDeleteSuccess", { username: targetName }));
      await refetchUsers();
    } else {
      showApiError(res, { fallbackKey: "settings:platformDeleteError" });
    }
  }

  // ─── Helpers ───

  // formatStorage + formatDateTime come from utils/adminFormat (shared). This
  // local wrapper binds the relative-time labels + fallback for the user list
  // so renderCell's call sites stay unchanged.
  function formatRelativeTime(iso: string | null) {
    return relativeTime(iso, nowMs, {
      neverLabel: t("platformUserNever"),
      justNowLabel: t("platformUserJustNow"),
      fallback: formatDateTime,
    });
  }

  // ─── Status badge ───
  function statusBadge(status: string) {
    const statusMap: Record<string, string> = {
      online: "platformUserStatusOnline",
      idle: "platformUserStatusIdle",
      dnd: "platformUserStatusDND",
      offline: "platformUserStatusOffline",
    };
    const labelKey = statusMap[status] ?? "platformUserStatusOffline";
    return (
      <span className={`admin-user-status-badge ${status}`}>
        {t(labelKey)}
      </span>
    );
  }

  // ─── Render cell ───
  function renderCell(user: AdminUserListItem, colKey: SortKey) {
    switch (colKey) {
      case "username":
        return (
          <div className="admin-user-name-cell">
            <div className="admin-user-avatar">
              {user.avatar_url ? (
                <img src={resolveAssetUrl(user.avatar_url)} alt="" loading="lazy" decoding="async" />
              ) : (
                user.username.charAt(0).toUpperCase()
              )}
            </div>
            <span title={user.username}>{user.username}</span>
            {user.is_platform_banned && (
              <span className="admin-user-banned-badge">{t("platformUserBannedBadge")}</span>
            )}
          </div>
        );

      case "display_name":
        return (
          <span className="admin-user-display-name" title={user.display_name ?? ""}>
            {user.display_name ?? "—"}
          </span>
        );

      case "id":
        return (
          <span className="admin-user-id" title={user.id}>
            {user.id.slice(0, 8)}...
          </span>
        );

      case "created_at":
        return formatDateTime(user.created_at);

      case "status":
        return statusBadge(user.status);

      case "is_platform_admin":
        return user.is_platform_admin ? (
          <span className="admin-user-admin-badge">{t("platformUserAdminYes")}</span>
        ) : (
          <span className="admin-user-text-muted">—</span>
        );

      case "last_activity":
        return formatRelativeTime(user.last_activity);

      case "message_count":
        return user.message_count.toLocaleString();

      case "storage_mb":
        return formatStorage(user.storage_mb);

      case "owned_self_servers":
        return user.owned_self_servers;

      case "owned_mqvi_servers":
        return user.owned_mqvi_servers;

      case "member_server_count":
        return user.member_server_count;

      case "ban_count":
        return user.ban_count > 0 ? (
          <span className="admin-user-ban-count">{user.ban_count}</span>
        ) : (
          <span className="admin-user-text-muted">0</span>
        );

      default:
        return null;
    }
  }

  // ─── Render ───
  return (
    <AdminTable
      classPrefix="admin-user"
      columns={COLUMNS}
      rows={sortedRows}
      totalCount={users.length}
      isLoading={isLoading}
      loadingText={t("loading")}
      emptyText={t("platformUserNoUsers")}
      noResultsText={t("platformUserNoResults")}
      searchQuery={searchQuery}
      onSearchChange={setSearchQuery}
      searchPlaceholder={t("platformUserSearchPlaceholder")}
      columnWidths={columnWidths}
      onResizeStart={handleResizeStart}
      sortKey={sortKey}
      sortDir={sortDir}
      onSort={handleSort}
      getColumnLabel={(col) => t(col.labelKey)}
      getRowKey={(u) => u.id}
      getRowClassName={(u) => (u.is_platform_banned ? "admin-user-row-banned" : "")}
      onRowContextMenu={(e, u) => {
        const items = buildContextItems(u);
        if (items.length > 0) openMenu(e, items);
      }}
      renderCell={renderCell}
    >
      {/* Context Menu */}
      <ContextMenu state={menuState} onClose={closeMenu} />

      {/* Ban Dialog */}
      {banTarget && (
        <PlatformBanDialog
          username={banTarget.username}
          onConfirm={handleBanConfirm}
          onCancel={() => setBanTarget(null)}
        />
      )}

      {/* Delete Dialog */}
      {deleteTarget && (
        <PlatformActionDialog
          title={t("platformDeleteTitle")}
          description={t("platformDeleteDescription", { username: deleteTarget.username })}
          reasonLabel={t("platformDeleteReasonLabel")}
          reasonPlaceholder={t("platformDeleteReasonPlaceholder")}
          confirmLabel={t("platformDeleteConfirm")}
          onConfirm={handleDeleteConfirm}
          onCancel={() => setDeleteTarget(null)}
        />
      )}

      {/* Badge Assign Modal */}
      {badgeTarget && (
        <BadgeAssignModal
          member={{
            id: badgeTarget.id,
            username: badgeTarget.username,
            display_name: badgeTarget.display_name,
            avatar_url: badgeTarget.avatar_url,
            status: badgeTarget.status as "online" | "idle" | "dnd" | "offline",
            custom_status: null,
            created_at: badgeTarget.created_at,
            roles: [],
            effective_permissions: 0,
          }}
          onClose={() => setBadgeTarget(null)}
        />
      )}
    </AdminTable>
  );
}

export default AdminUserList;
