/** AdminServerList — Platform admin server management table with LiveKit instance migration. */

import { useEffect, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useToastStore } from "../../stores/toastStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useDMStore } from "../../stores/dmStore";
import { useUIStore } from "../../stores/uiStore";
import {
  listLiveKitInstances,
  listAdminServers,
  migrateServerInstance,
  adminDeleteServer,
} from "../../api/admin";
import { useContextMenu } from "../../hooks/useContextMenu";
import ContextMenu from "../shared/ContextMenu";
import PlatformActionDialog from "./PlatformActionDialog";
import type { LiveKitInstanceAdmin, AdminServerListItem } from "../../types";
import type { ContextMenuItem } from "../../hooks/useContextMenu";
import { resolveAssetUrl } from "../../utils/constants";
import AdminTable from "./AdminTable";
import type { ColumnDef } from "./adminTableTypes";
import { useNowTick } from "../../hooks/useNowTick";
import { useTableFilter } from "../../hooks/useTableFilter";
import { useTableSort } from "../../hooks/useTableSort";
import { useColumnResize } from "../../hooks/useColumnResize";
import { parseUTC, formatStorage, formatDate, formatRelativeTime as relativeTime } from "../../utils/adminFormat";

// ─── Column Definition ───

type SortKey =
  | "name"
  | "id"
  | "owner_username"
  | "created_at"
  | "type"
  | "member_count"
  | "channel_count"
  | "message_count"
  | "storage_mb"
  | "last_activity"
  | "instance";

const COLUMNS: ColumnDef<SortKey>[] = [
  { key: "name", labelKey: "platformServerName", defaultWidth: 180, minWidth: 120, sortable: true, align: "left" },
  { key: "id", labelKey: "platformServerID", defaultWidth: 110, minWidth: 80, sortable: false, align: "left" },
  { key: "owner_username", labelKey: "platformServerCreator", defaultWidth: 110, minWidth: 80, sortable: true, align: "left" },
  { key: "created_at", labelKey: "platformServerCreated", defaultWidth: 120, minWidth: 90, sortable: true, align: "left" },
  { key: "type", labelKey: "platformServerType", defaultWidth: 140, minWidth: 100, sortable: true, align: "left" },
  { key: "member_count", labelKey: "platformServerMembers", defaultWidth: 80, minWidth: 60, sortable: true, align: "right" },
  { key: "channel_count", labelKey: "platformServerChannels", defaultWidth: 80, minWidth: 60, sortable: true, align: "right" },
  { key: "message_count", labelKey: "platformServerMessages", defaultWidth: 90, minWidth: 70, sortable: true, align: "right" },
  { key: "storage_mb", labelKey: "platformServerStorage", defaultWidth: 85, minWidth: 65, sortable: true, align: "right" },
  { key: "last_activity", labelKey: "platformServerLastActivity", defaultWidth: 110, minWidth: 80, sortable: true, align: "left" },
  { key: "instance", labelKey: "platformServerLiveKitInstance", defaultWidth: 210, minWidth: 150, sortable: false, align: "left" },
];

/** Search predicate — name, id, or owner username (case-insensitive). */
function matchesServer(s: AdminServerListItem, q: string): boolean {
  return (
    s.name.toLowerCase().includes(q) ||
    s.id.toLowerCase().includes(q) ||
    s.owner_username.toLowerCase().includes(q)
  );
}

// ─── Sort comparator ───

function compareSortValue(
  a: AdminServerListItem,
  b: AdminServerListItem,
  key: SortKey,
  dir: "asc" | "desc",
): number {
  let result = 0;

  switch (key) {
    case "name":
      result = a.name.localeCompare(b.name);
      break;
    case "owner_username":
      result = a.owner_username.localeCompare(b.owner_username);
      break;
    case "created_at":
      result = new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
      break;
    case "type":
      result = (a.is_platform_managed ? 1 : 0) - (b.is_platform_managed ? 1 : 0);
      break;
    case "member_count":
      result = a.member_count - b.member_count;
      break;
    case "channel_count":
      result = a.channel_count - b.channel_count;
      break;
    case "message_count":
      result = a.message_count - b.message_count;
      break;
    case "storage_mb":
      result = a.storage_mb - b.storage_mb;
      break;
    case "last_activity": {
      const aTime = a.last_activity ? parseUTC(a.last_activity) : 0;
      const bTime = b.last_activity ? parseUTC(b.last_activity) : 0;
      result = aTime - bTime;
      break;
    }
    default:
      result = 0;
  }

  return dir === "desc" ? -result : result;
}

// ─── Component ───

function AdminServerList() {
  const { t } = useTranslation("settings");
  const addToast = useToastStore((s) => s.addToast);
  const { menuState, openMenu, closeMenu } = useContextMenu();

  // ─── Data state ───
  const [servers, setServers] = useState<AdminServerListItem[]>([]);
  const [instances, setInstances] = useState<LiveKitInstanceAdmin[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // ─── Delete dialog state ───
  const [deleteTarget, setDeleteTarget] = useState<AdminServerListItem | null>(null);

  // ─── Table state (search + shared sort/filter/resize/now hooks) ───
  const [searchQuery, setSearchQuery] = useState("");
  const nowMs = useNowTick();
  const { columnWidths, handleResizeStart } = useColumnResize(COLUMNS);
  const filteredServers = useTableFilter(servers, searchQuery, matchesServer);
  const { sortKey, sortDir, sortedRows, handleSort } = useTableSort(
    filteredServers,
    COLUMNS,
    compareSortValue,
    "name",
    "asc",
  );

  // ─── Migration state ───
  const [pendingChanges, setPendingChanges] = useState<Record<string, string>>({});
  const [savingServers, setSavingServers] = useState<Set<string>>(new Set());

  // ─── Fetch ───
  useEffect(() => {
    async function load() {
      setIsLoading(true);
      const [srvRes, instRes] = await Promise.all([
        listAdminServers(),
        listLiveKitInstances(),
      ]);
      if (srvRes.success && srvRes.data) setServers(srvRes.data);
      else addToast("error", srvRes.error ?? t("platformServerLoadError"));

      if (instRes.success && instRes.data) setInstances(instRes.data);
      setIsLoading(false);
    }
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Instance change ───
  function handleInstanceChange(serverId: string, newInstanceId: string) {
    const server = servers.find((s) => s.id === serverId);
    if (server?.livekit_instance_id === newInstanceId) {
      setPendingChanges((prev) => {
        const copy = { ...prev };
        delete copy[serverId];
        return copy;
      });
    } else {
      setPendingChanges((prev) => ({ ...prev, [serverId]: newInstanceId }));
    }
  }

  function handleCancelChange(serverId: string) {
    setPendingChanges((prev) => {
      const copy = { ...prev };
      delete copy[serverId];
      return copy;
    });
  }

  async function handleConfirm(serverId: string) {
    const newInstanceId = pendingChanges[serverId];
    if (!newInstanceId) return;

    setSavingServers((prev) => new Set(prev).add(serverId));
    const res = await migrateServerInstance(serverId, newInstanceId);
    setSavingServers((prev) => {
      const copy = new Set(prev);
      copy.delete(serverId);
      return copy;
    });

    if (res.success) {
      // Reflect the target instance's actual cloud/self-hosted flag — hardcoding
      // `true` here would desync the row badge whenever the user picks a
      // self-hosted instance.
      const target = instances.find((i) => i.id === newInstanceId);
      const targetIsManaged = target?.is_platform_managed ?? true;
      setServers((prev) =>
        prev.map((s) =>
          s.id === serverId
            ? { ...s, livekit_instance_id: newInstanceId, is_platform_managed: targetIsManaged }
            : s,
        ),
      );
      setPendingChanges((prev) => {
        const copy = { ...prev };
        delete copy[serverId];
        return copy;
      });
      addToast("success", t("platformServerInstanceUpdated"));
    } else {
      addToast("error", res.error ?? t("platformServerInstanceUpdateError"));
    }
  }

  // ─── Helpers ───

  // formatStorage + formatDate come from utils/adminFormat (shared). This
  // local wrapper binds the relative-time labels + date-only fallback for the
  // server list so renderCell's call sites stay unchanged.
  function formatRelativeTime(iso: string | null) {
    return relativeTime(iso, nowMs, {
      neverLabel: t("platformServerNever"),
      justNowLabel: t("platformServerJustNow"),
      fallback: formatDate,
    });
  }

  function instanceLabel(id: string) {
    const inst = instances.find((i) => i.id === id);
    if (!inst) return id;
    try {
      return new URL(inst.url).hostname;
    } catch {
      return inst.url;
    }
  }

  // ─── Context Menu ───

  const refetchServers = useCallback(async () => {
    const res = await listAdminServers();
    if (res.success && res.data) {
      setServers(res.data);
    }
  }, []);

  function buildContextItems(srv: AdminServerListItem): ContextMenuItem[] {
    const items: ContextMenuItem[] = [];

    items.push({
      label: t("platformServerSendDMOwner"),
      onClick: () => handleSendDMOwner(srv),
    });

    items.push({
      label: t("platformServerDelete"),
      danger: true,
      separator: true,
      onClick: () => setDeleteTarget(srv),
    });

    return items;
  }

  async function handleSendDMOwner(srv: AdminServerListItem) {
    const channelId = await useDMStore.getState().createOrGetChannel(srv.owner_id);
    if (channelId) {
      useUIStore.getState().openTab(channelId, "dm", srv.owner_username);
      useSettingsStore.getState().closeSettings();
    }
  }

  async function handleDeleteConfirm(reason: string) {
    if (!deleteTarget) return;
    const targetId = deleteTarget.id;
    const targetName = deleteTarget.name;
    setDeleteTarget(null);

    const res = await adminDeleteServer(targetId, reason ? { reason } : undefined);
    if (res.success) {
      addToast("success", t("platformServerDeleteSuccess", { serverName: targetName }));
      await refetchServers();
    } else {
      addToast("error", res.error ?? t("platformServerDeleteError"));
    }
  }

  // ─── Render cell ───
  function renderCell(srv: AdminServerListItem, colKey: SortKey) {
    switch (colKey) {
      case "name":
        return (
          <div className="admin-server-name-cell">
            <div className="admin-server-icon">
              {srv.icon_url ? (
                <img src={resolveAssetUrl(srv.icon_url)} alt="" loading="lazy" decoding="async" />
              ) : (
                srv.name.charAt(0).toUpperCase()
              )}
            </div>
            <span title={srv.name}>{srv.name}</span>
          </div>
        );

      case "id":
        return (
          <span className="admin-server-id" title={srv.id}>
            {srv.id.slice(0, 8)}...
          </span>
        );

      case "owner_username":
        return srv.owner_username;

      case "created_at":
        return formatDate(srv.created_at);

      case "type":
        return (
          <span
            className={`admin-server-type-badge ${srv.is_platform_managed ? "managed" : "self"}`}
          >
            {srv.is_platform_managed
              ? t("platformServerTypeManaged")
              : t("platformServerTypeSelf")}
          </span>
        );

      case "member_count":
        return srv.member_count;

      case "channel_count":
        return srv.channel_count;

      case "message_count":
        return srv.message_count.toLocaleString();

      case "storage_mb":
        return formatStorage(srv.storage_mb);

      case "last_activity":
        return formatRelativeTime(srv.last_activity);

      case "instance": {
        const hasPending = pendingChanges[srv.id] !== undefined;
        const isSavingThis = savingServers.has(srv.id);
        const currentInstanceId = hasPending
          ? pendingChanges[srv.id]
          : (srv.livekit_instance_id ?? "");

        return (
          <div className="admin-server-instance-cell">
            <select
              className="admin-server-instance-select"
              value={currentInstanceId}
              onChange={(e) => handleInstanceChange(srv.id, e.target.value)}
              disabled={isSavingThis}
            >
              {instances.map((inst) => (
                <option key={inst.id} value={inst.id}>
                  {instanceLabel(inst.id)}
                  {inst.is_platform_managed ? "" : ` — ${t("platformServerTypeSelf")}`}
                </option>
              ))}
            </select>
            {hasPending && (
              <>
                <button
                  className="admin-server-confirm-btn"
                  onClick={() => handleConfirm(srv.id)}
                  disabled={isSavingThis}
                  title={t("save")}
                >
                  {isSavingThis ? "..." : "✓"}
                </button>
                <button
                  className="admin-server-cancel-btn"
                  onClick={() => handleCancelChange(srv.id)}
                  disabled={isSavingThis}
                  title={t("cancel")}
                >
                  {"✕"}
                </button>
              </>
            )}
          </div>
        );
      }

      default:
        return null;
    }
  }

  // ─── Render ───
  return (
    <AdminTable
      classPrefix="admin-server"
      columns={COLUMNS}
      rows={sortedRows}
      totalCount={servers.length}
      isLoading={isLoading}
      loadingText={t("loading")}
      emptyText={t("platformServerNoServers")}
      noResultsText={t("platformServerNoResults")}
      searchQuery={searchQuery}
      onSearchChange={setSearchQuery}
      searchPlaceholder={t("platformServerSearchPlaceholder")}
      columnWidths={columnWidths}
      onResizeStart={handleResizeStart}
      sortKey={sortKey}
      sortDir={sortDir}
      onSort={handleSort}
      getColumnLabel={(col) => t(col.labelKey)}
      getRowKey={(s) => s.id}
      onRowContextMenu={(e, s) => {
        const items = buildContextItems(s);
        if (items.length > 0) openMenu(e, items);
      }}
      renderCell={renderCell}
    >
      {/* Context Menu */}
      <ContextMenu state={menuState} onClose={closeMenu} />

      {/* Delete Dialog */}
      {deleteTarget && (
        <PlatformActionDialog
          title={t("platformServerDeleteTitle")}
          description={t("platformServerDeleteDescription", { serverName: deleteTarget.name })}
          reasonLabel={t("platformServerDeleteReasonLabel")}
          reasonPlaceholder={t("platformServerDeleteReasonPlaceholder")}
          confirmLabel={t("platformServerDeleteConfirm")}
          onConfirm={handleDeleteConfirm}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </AdminTable>
  );
}

export default AdminServerList;
