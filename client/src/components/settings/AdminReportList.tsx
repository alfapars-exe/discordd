/**
 * AdminReportList — Platform admin report management table.
 * Sortable columns, search + status filter, resizable columns,
 * inline status editing, context menu (DM/ban/delete), attachment modal.
 * Only visible to platform admins (backend-protected).
 */

import { useEffect, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useToastStore } from "../../stores/toastStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useDMStore } from "../../stores/dmStore";
import { useUIStore } from "../../stores/uiStore";
import { listAdminReports, updateReportStatus, platformBanUser, hardDeleteUser } from "../../api/admin";
import { useContextMenu } from "../../hooks/useContextMenu";
import ContextMenu from "../shared/ContextMenu";
import Modal from "../shared/Modal";
import PlatformBanDialog from "./PlatformBanDialog";
import PlatformActionDialog from "./PlatformActionDialog";
import type { AdminReportListItem } from "../../types";
import { resolveAssetUrl } from "../../utils/constants";
import type { ContextMenuItem } from "../../hooks/useContextMenu";
import AdminTable from "./AdminTable";
import type { ColumnDef } from "./adminTableTypes";
import { useTableFilter } from "../../hooks/useTableFilter";
import { useTableSort } from "../../hooks/useTableSort";
import { useColumnResize } from "../../hooks/useColumnResize";
import { parseUTC, formatDateTime } from "../../utils/adminFormat";

// --- Column Definition ---

type SortKey =
  | "reporter_username"
  | "reported_username"
  | "reason"
  | "description"
  | "attachments"
  | "created_at"
  | "status";

const COLUMNS: ColumnDef<SortKey>[] = [
  { key: "reporter_username", labelKey: "platformReportReporter", defaultWidth: 140, minWidth: 100, sortable: true, align: "left" },
  { key: "reported_username", labelKey: "platformReportReported", defaultWidth: 140, minWidth: 100, sortable: true, align: "left" },
  { key: "reason", labelKey: "platformReportReason", defaultWidth: 140, minWidth: 100, sortable: true, align: "left" },
  { key: "description", labelKey: "platformReportDescription", defaultWidth: 250, minWidth: 120, sortable: false, align: "left" },
  { key: "attachments", labelKey: "platformReportFiles", defaultWidth: 70, minWidth: 55, sortable: true, align: "center" },
  { key: "created_at", labelKey: "platformReportDate", defaultWidth: 155, minWidth: 120, sortable: true, align: "left" },
  { key: "status", labelKey: "platformReportStatus", defaultWidth: 180, minWidth: 140, sortable: true, align: "left" },
];

// --- Status filter options ---
const STATUS_OPTIONS = ["", "pending", "reviewed", "resolved", "dismissed"] as const;

// --- Reason -> i18n key map ---
const REASON_KEY_MAP: Record<string, string> = {
  spam: "platformReportReasonSpam",
  harassment: "platformReportReasonHarassment",
  inappropriate_content: "platformReportReasonInappropriate",
  impersonation: "platformReportReasonImpersonation",
  other: "platformReportReasonOther",
};

// --- Status -> i18n key map ---
const STATUS_KEY_MAP: Record<string, string> = {
  pending: "platformReportStatusPending",
  reviewed: "platformReportStatusReviewed",
  resolved: "platformReportStatusResolved",
  dismissed: "platformReportStatusDismissed",
};

/** Search predicate — reporter, reported, or description (case-insensitive). */
function matchesReport(r: AdminReportListItem, q: string): boolean {
  return (
    r.reporter_username.toLowerCase().includes(q) ||
    r.reported_username.toLowerCase().includes(q) ||
    r.description.toLowerCase().includes(q)
  );
}

// --- Sort comparator ---

function compareSortValue(
  a: AdminReportListItem,
  b: AdminReportListItem,
  key: SortKey,
  dir: "asc" | "desc",
): number {
  let result = 0;

  switch (key) {
    case "reporter_username":
      result = a.reporter_username.localeCompare(b.reporter_username);
      break;
    case "reported_username":
      result = a.reported_username.localeCompare(b.reported_username);
      break;
    case "reason":
      result = a.reason.localeCompare(b.reason);
      break;
    case "attachments":
      result = a.attachments.length - b.attachments.length;
      break;
    case "created_at":
      result = parseUTC(a.created_at) - parseUTC(b.created_at);
      break;
    case "status":
      result = a.status.localeCompare(b.status);
      break;
    default:
      result = 0;
  }

  return dir === "desc" ? -result : result;
}

// --- Component ---

function AdminReportList() {
  const { t } = useTranslation("settings");
  const addToast = useToastStore((s) => s.addToast);
  const { menuState, openMenu, closeMenu } = useContextMenu();

  // --- Data state ---
  const [reports, setReports] = useState<AdminReportListItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // --- Dialog state ---
  const [banTarget, setBanTarget] = useState<{ id: string; username: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; username: string } | null>(null);

  // --- Attachment modal state ---
  const [attachModalReport, setAttachModalReport] = useState<AdminReportListItem | null>(null);

  // --- Table state (search + status filter; shared sort/filter/resize hooks) ---
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const { columnWidths, handleResizeStart } = useColumnResize(COLUMNS);
  const filteredReports = useTableFilter(reports, searchQuery, matchesReport);
  const { sortKey, sortDir, sortedRows, handleSort } = useTableSort(
    filteredReports,
    COLUMNS,
    compareSortValue,
    "created_at",
    "desc",
  );

  // --- Status inline edit state ---
  const [pendingStatusChanges, setPendingStatusChanges] = useState<Record<string, string>>({});
  const [savingReports, setSavingReports] = useState<Set<string>>(new Set());

  // --- Fetch ---
  // Kept as a useCallback so the post-mutation manual refresh paths
  // can re-invoke it. The mount-time load runs inline below in an
  // async IIFE so the lint rule react-hooks/set-state-in-effect
  // doesn't fire on the synchronous fetcher call.
  const fetchReports = useCallback(async () => {
    setIsLoading(true);
    const res = await listAdminReports(statusFilter || undefined);
    if (res.success && res.data) {
      setReports(res.data.reports);
    } else {
      addToast("error", res.error ?? t("platformReportLoadError"));
    }
    setIsLoading(false);
  }, [statusFilter, addToast, t]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await listAdminReports(statusFilter || undefined);
      if (cancelled) return;
      if (res.success && res.data) {
        setReports(res.data.reports);
      } else {
        addToast("error", res.error ?? t("platformReportLoadError"));
      }
      setIsLoading(false);
    })();
    return () => { cancelled = true; };
  }, [statusFilter, addToast, t]);

  // --- Status inline edit ---
  function handleStatusChange(reportId: string, newStatus: string) {
    const report = reports.find((r) => r.id === reportId);
    if (!report) return;

    // If reverted to original status, remove pending change
    if (newStatus === report.status) {
      setPendingStatusChanges((prev) => {
        const next = { ...prev };
        delete next[reportId];
        return next;
      });
    } else {
      setPendingStatusChanges((prev) => ({ ...prev, [reportId]: newStatus }));
    }
  }

  async function handleStatusConfirm(reportId: string) {
    const newStatus = pendingStatusChanges[reportId];
    if (!newStatus) return;

    setSavingReports((prev) => new Set(prev).add(reportId));

    const res = await updateReportStatus(reportId, newStatus);
    if (res.success) {
      addToast("success", t("platformReportStatusUpdated"));
      setPendingStatusChanges((prev) => {
        const next = { ...prev };
        delete next[reportId];
        return next;
      });
      await fetchReports();
    } else {
      addToast("error", res.error ?? t("platformReportStatusUpdateError"));
    }

    setSavingReports((prev) => {
      const next = new Set(prev);
      next.delete(reportId);
      return next;
    });
  }

  function handleStatusCancel(reportId: string) {
    setPendingStatusChanges((prev) => {
      const next = { ...prev };
      delete next[reportId];
      return next;
    });
  }

  // --- Context Menu ---

  function buildContextItems(report: AdminReportListItem): ContextMenuItem[] {
    const items: ContextMenuItem[] = [];

    items.push({
      label: t("platformReportDMReporter"),
      onClick: () => handleSendDM(report.reporter_id, report.reporter_display_name ?? report.reporter_username),
    });

    items.push({
      label: t("platformReportDMReported"),
      onClick: () => handleSendDM(report.reported_user_id, report.reported_display_name ?? report.reported_username),
    });

    items.push({
      label: t("platformReportBanReported"),
      danger: true,
      separator: true,
      onClick: () => setBanTarget({ id: report.reported_user_id, username: report.reported_username }),
    });

    items.push({
      label: t("platformReportDeleteReported"),
      danger: true,
      onClick: () => setDeleteTarget({ id: report.reported_user_id, username: report.reported_username }),
    });

    return items;
  }

  async function handleSendDM(userId: string, displayName: string) {
    const channelId = await useDMStore.getState().createOrGetChannel(userId);
    if (channelId) {
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
      await fetchReports();
    } else {
      addToast("error", res.error ?? t("platformBanError"));
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
      await fetchReports();
    } else {
      addToast("error", res.error ?? t("platformDeleteError"));
    }
  }

  // --- Helpers ---

  function formatFileSize(bytes: number | null) {
    if (bytes === null || bytes === 0) return "";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / 1048576).toFixed(1)} MB`;
  }

  // --- Reason badge ---
  function reasonBadge(reason: string) {
    const labelKey = REASON_KEY_MAP[reason] ?? "platformReportReasonOther";
    return (
      <span className={`admin-report-reason-badge ${reason}`}>
        {t(labelKey)}
      </span>
    );
  }

  // --- Render cell ---
  function renderCell(report: AdminReportListItem, colKey: SortKey) {
    switch (colKey) {
      case "reporter_username":
        return (
          <span title={report.reporter_username}>
            {report.reporter_display_name ?? report.reporter_username}
          </span>
        );

      case "reported_username":
        return (
          <span title={report.reported_username}>
            {report.reported_display_name ?? report.reported_username}
          </span>
        );

      case "reason":
        return reasonBadge(report.reason);

      case "description":
        return (
          <span className="admin-report-desc-cell" title={report.description}>
            {report.description}
          </span>
        );

      case "attachments": {
        const count = report.attachments.length;
        if (count === 0) {
          return <span className="admin-report-text-muted">{"—"}</span>;
        }
        return (
          <button
            className="admin-report-attach-btn"
            onClick={(e) => {
              e.stopPropagation();
              setAttachModalReport(report);
            }}
          >
            {t("platformReportFileCount", { count })}
          </button>
        );
      }

      case "created_at":
        return formatDateTime(report.created_at, { assumeUTC: true });

      case "status": {
        const hasPending = pendingStatusChanges[report.id] !== undefined;
        const isSaving = savingReports.has(report.id);
        const currentStatus = hasPending
          ? pendingStatusChanges[report.id]
          : report.status;

        return (
          <div className="admin-report-status-cell">
            <select
              className="admin-report-status-select"
              value={currentStatus}
              onChange={(e) => handleStatusChange(report.id, e.target.value)}
              disabled={isSaving}
            >
              {Object.entries(STATUS_KEY_MAP).map(([value, labelKey]) => (
                <option key={value} value={value}>
                  {t(labelKey)}
                </option>
              ))}
            </select>
            {hasPending && (
              <>
                <button
                  className="admin-report-confirm-btn"
                  onClick={() => handleStatusConfirm(report.id)}
                  disabled={isSaving}
                  title={t("save")}
                >
                  {isSaving ? "..." : "✓"}
                </button>
                <button
                  className="admin-report-cancel-btn"
                  onClick={() => handleStatusCancel(report.id)}
                  disabled={isSaving}
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

  // --- Status filter (toolbar extra) ---
  const statusFilterSelect = (
    <select
      className="admin-report-status-filter"
      value={statusFilter}
      onChange={(e) => setStatusFilter(e.target.value)}
    >
      {STATUS_OPTIONS.map((s) => (
        <option key={s} value={s}>
          {s === "" ? t("platformReportStatusAll") : t(STATUS_KEY_MAP[s] ?? s)}
        </option>
      ))}
    </select>
  );

  // --- Render ---
  return (
    <AdminTable
      classPrefix="admin-report"
      columns={COLUMNS}
      rows={sortedRows}
      totalCount={reports.length}
      isLoading={isLoading}
      loadingText={t("loading")}
      emptyText={t("platformReportNoReports")}
      noResultsText={t("platformReportNoResults")}
      searchQuery={searchQuery}
      onSearchChange={setSearchQuery}
      searchPlaceholder={t("platformReportSearchPlaceholder")}
      toolbarExtra={statusFilterSelect}
      columnWidths={columnWidths}
      onResizeStart={handleResizeStart}
      sortKey={sortKey}
      sortDir={sortDir}
      onSort={handleSort}
      getColumnLabel={(col) => t(col.labelKey)}
      getRowKey={(r) => r.id}
      onRowContextMenu={(e, r) => {
        const items = buildContextItems(r);
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

      {/* Attachment Modal */}
      <Modal
        isOpen={!!attachModalReport}
        onClose={() => setAttachModalReport(null)}
        title={t("platformReportAttachments")}
      >
        {attachModalReport && attachModalReport.attachments.length > 0 ? (
          <div className="admin-report-attach-modal">
            {attachModalReport.attachments.map((att) => (
              <div key={att.id} className="admin-report-attach-item">
                {att.mime_type?.startsWith("image/") ? (
                  <img
                    src={resolveAssetUrl(att.file_url)}
                    alt={att.filename}
                    className="admin-report-attach-img"
                  />
                ) : (
                  <a
                    href={resolveAssetUrl(att.file_url)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="admin-report-attach-link"
                  >
                    {att.filename}
                  </a>
                )}
                <div className="admin-report-attach-info">
                  <span>{att.filename}</span>
                  {att.file_size !== null && <span>{formatFileSize(att.file_size)}</span>}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="admin-report-no-attach">{t("platformReportNoAttachments")}</p>
        )}
      </Modal>
    </AdminTable>
  );
}

export default AdminReportList;
