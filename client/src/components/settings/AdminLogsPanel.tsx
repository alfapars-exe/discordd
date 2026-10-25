/**
 * AdminLogsPanel — Platform admin structured log viewer.
 * Shows voice/video/WS/auth errors stored in app_logs table.
 * Filter by category, level, search text. Paginated. Clear all button.
 */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useToastStore } from "../../stores/toastStore";
import { showApiError } from "../../utils/apiError";
import { useConfirm } from "../../hooks/useConfirm";
import { listAppLogs, clearAppLogs, getAppLogHealth } from "../../api/admin";
import type { AppLog, AppLogLevel, AppLogHealth } from "../../types";
import { formatDateTime } from "../../utils/dateFormat";
import { normalizeLogTimestamp } from "../../utils/logTimestamp";

const PAGE_SIZE = 50;

const LEVEL_OPTIONS: { value: string; labelKey: string }[] = [
  { value: "", labelKey: "platformLogsAllLevels" },
  { value: "error", labelKey: "platformLogsLevelError" },
  { value: "warn", labelKey: "platformLogsLevelWarn" },
  { value: "info", labelKey: "platformLogsLevelInfo" },
];

const CATEGORY_OPTIONS: { value: string; labelKey: string }[] = [
  { value: "", labelKey: "platformLogsAllCategories" },
  { value: "voice", labelKey: "platformLogsCategoryVoice" },
  { value: "livekit", labelKey: "platformLogsCategoryLiveKit" },
  { value: "video", labelKey: "platformLogsCategoryVideo" },
  { value: "screen_share", labelKey: "platformLogsCategoryScreenShare" },
  { value: "ws", labelKey: "platformLogsCategoryWs" },
  { value: "auth", labelKey: "platformLogsCategoryAuth" },
  { value: "general", labelKey: "platformLogsCategoryGeneral" },
  { value: "feedback", labelKey: "platformLogsCategoryFeedback" },
  { value: "client", labelKey: "platformLogsCategoryClient" },
];

function levelBadgeClass(level: AppLogLevel): string {
  switch (level) {
    case "error":
      return "log-badge log-badge-error";
    case "warn":
      return "log-badge log-badge-warn";
    case "info":
      return "log-badge log-badge-info";
    default:
      return "log-badge";
  }
}

/** Parse backend SQLite timestamps as UTC. */
function formatTimestamp(iso: string): string { return formatDateTime(normalizeLogTimestamp(iso)); }

function parseMetadata(raw: string): Record<string, string> | null {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && Object.keys(parsed).length > 0) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

function AdminLogsPanel() {
  const { t } = useTranslation("settings");
  const addToast = useToastStore((s) => s.addToast);
  const confirm = useConfirm();

  const [logs, setLogs] = useState<AppLog[]>([]);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [page, setPage] = useState(0);

  // Filters
  const [level, setLevel] = useState("");
  const [category, setCategory] = useState("");
  const [search, setSearch] = useState("");
  const [advanced,setAdvanced]=useState({request_id:"",event_code:"",component:"",from:"",to:""});
  const [health,setHealth]=useState<AppLogHealth | null>(null);
  const [refresh,setRefresh]=useState(0);
  const [expandedIds,setExpandedIds]=useState<Set<string>>(new Set());

  useEffect(()=>{
    let cancelled=false;
    const timer=setTimeout(()=>{
      void (async()=>{
        setIsLoading(true);
        const dates={from:advanced.from ? new Date(advanced.from).toISOString():undefined,to:advanced.to ? new Date(advanced.to).toISOString():undefined};
        const [logsResult,healthResult]=await Promise.allSettled([
          listAppLogs({level,category,search,...advanced,...dates,limit:PAGE_SIZE,offset:page*PAGE_SIZE}),getAppLogHealth(),
        ]);
        if (cancelled) return;
        if (healthResult.status==="fulfilled" && healthResult.value.success && healthResult.value.data) setHealth(healthResult.value.data);
        if(logsResult.status==="fulfilled"){
          const res=logsResult.value;
          if(res.success && res.data){setLogs(res.data.logs ?? []);setTotal(res.data.total)}
          else showApiError(res,{fallbackKey:"settings:platformLogsLoadError"});
        } else addToast("error",t("platformLogsLoadError"));
        setIsLoading(false);
      })();
    },300);
    return ()=>{clearTimeout(timer);cancelled=true};
  },[level,category,search,advanced,page,refresh,addToast,t]);

  function handleFilterChange(newLevel:string,newCategory:string){setLevel(newLevel);setCategory(newCategory);setPage(0);setExpandedIds(new Set())}
  function handleSearchChange(value:string){setSearch(value);setPage(0);setExpandedIds(new Set())}
  function handlePageChange(value:number){setPage(value);setExpandedIds(new Set())}
  function updateAdvanced(key:keyof typeof advanced,value:string){setAdvanced(prev=>({...prev,[key]:value}));setPage(0);setExpandedIds(new Set())}

  async function handleClear() {
    const ok = await confirm({
      message: t("platformLogsClearConfirm"),
      danger: true,
    });
    if (!ok) return;

    try {
      const res = await clearAppLogs();
      if (res.success) {
        setLogs([]);
        setRefresh(v=>v+1);
        setTotal(0);
        setPage(0);
        addToast("success", t("platformLogsCleared"));
      } else {
        showApiError(res, { fallbackKey: "settings:platformLogsClearError" });
      }
    } catch {
      addToast("error", t("platformLogsClearError"));
    }
  }

  function toggleExpand(id: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const totalPages = Math.ceil(total / PAGE_SIZE);

  return (
    <div className="admin-logs-panel">
      {/* Header */}
      <div className="admin-logs-header">
        <h2 className="settings-section-title">{t("platformLogsTitle")}</h2>
        <div className="admin-logs-actions">
        <button className="settings-btn" onClick={()=>setRefresh(v=>v+1)}>{t("platformLogsRefresh")}</button>
        <button
          className="settings-btn settings-btn-danger"
          onClick={handleClear}
          disabled={total === 0}
        >
          {t("platformLogsClearAll")}
        </button>
        </div>
      </div>

      {health && <div className="admin-logs-health" role="status">
        <p>{t("platformLogsHealth",{errors:health.error_queue,errorCapacity:health.error_capacity,normal:health.normal_queue,normalCapacity:health.normal_capacity,days:health.retention_days})}</p>
        <p>{t("platformLogsLastWrite",{time:health.last_success_at ? formatTimestamp(health.last_success_at):t("platformLogsNoWrite")})}</p>
        {(health.dropped_error+health.dropped_warn+health.dropped_info+health.failed_events)>0 && <p className="log-badge-error">{t("platformLogsLoss",{errors:health.dropped_error,warnings:health.dropped_warn,info:health.dropped_info,failed:health.failed_events,writes:health.write_failures})}</p>}
      </div>}
      {/* Filters */}
      <div className="admin-logs-filters">
        <select
          className="admin-logs-select"
          value={level}
          onChange={(e) => handleFilterChange(e.target.value, category)}
        >
          {LEVEL_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {t(opt.labelKey)}
            </option>
          ))}
        </select>

        <select
          className="admin-logs-select"
          value={category}
          onChange={(e) => handleFilterChange(level, e.target.value)}
        >
          {CATEGORY_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {t(opt.labelKey)}
            </option>
          ))}
        </select>

        <input
          type="text"
          className="admin-logs-search"
          placeholder={t("platformLogsSearchPlaceholder")}
          value={search}
          onChange={(e) => handleSearchChange(e.target.value)}
        />
      </div>

      <div className="admin-logs-filters">
        {(["request_id","event_code","component"] as const).map(key=><input key={key} type="text" className="admin-logs-search" aria-label={t(`platformLogsFilter_${key}`)} placeholder={t(`platformLogsFilter_${key}`)} value={advanced[key]} onChange={e=>updateAdvanced(key,e.target.value)} />)}
        {(["from","to"] as const).map(key=><label key={key} className="admin-logs-date">{t(`platformLogsFilter_${key}`)}<input className="admin-logs-select" type="datetime-local" aria-label={t(`platformLogsFilter_${key}`)} value={advanced[key]} onChange={e=>updateAdvanced(key,e.target.value)} /></label>)}
      </div>
      {/* Log list */}
      <div className="admin-logs-list">
        {isLoading && <p className="no-channel">{t("loading")}</p>}

        {!isLoading && logs.length === 0 && (
          <p className="no-channel">{t("platformLogsEmpty")}</p>
        )}

        {!isLoading &&
          logs.map((log) => {
            const meta = parseMetadata(log.metadata);
            const isExpanded = expandedIds.has(log.id);

            return (
              <div
                key={log.id}
                className={`admin-log-entry${isExpanded ? " expanded" : ""}`}
                onClick={() => meta && toggleExpand(log.id)}
                style={{ cursor: meta ? "pointer" : "default" }}
              >
                <div className="admin-log-row">
                  <span className={levelBadgeClass(log.level)}>
                    {log.level.toUpperCase()}
                  </span>
                  <span className="admin-log-category">{log.category}</span>
                  {log.user_id && (
                    <span className="admin-log-user" title={log.user_id}>
                      {log.display_name || log.username || log.user_id.slice(0, 8)}
                    </span>
                  )}
                  <span className="admin-log-message">{log.message}</span>

                  <span className="admin-log-time">
                    {formatTimestamp(log.created_at)}

                  </span>
                </div>

                <div className="admin-log-diagnostics">
                  {log.event_code && <span>{log.event_code}</span>}
                  {log.component && <span>{log.component}</span>}
                  {(log.occurrence_count ?? 1)>1 && <span>{t("platformLogsOccurrences",{count:log.occurrence_count})}</span>}
                  {log.request_id && <code>{log.request_id}</code>}
                  {log.last_seen_at && log.last_seen_at!==log.created_at && <span>{t("platformLogsLastSeen",{time:formatTimestamp(log.last_seen_at)})}</span>}
                </div>

                {isExpanded && meta && (
                  <div className="admin-log-metadata">
                    {Object.entries(meta).map(([key, value]) => (
                      <div key={key} className="admin-log-meta-item">
                        <span className="admin-log-meta-key">{key}:</span>
                        <span className="admin-log-meta-value">{value}</span>
                      </div>
                    ))}
                    {log.user_id && (
                      <div className="admin-log-meta-item">
                        <span className="admin-log-meta-key">user_id:</span>
                        <span className="admin-log-meta-value">{log.user_id}</span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="admin-logs-pagination">
          <button
            className="settings-btn"
            disabled={page === 0}
            onClick={() => handlePageChange(page - 1)}
          >
            ‹
          </button>
          <span className="admin-logs-page-info">
            {t("platformLogsPage", { current: page + 1, total: totalPages })}
          </span>
          <button
            className="settings-btn"
            disabled={page >= totalPages - 1}
            onClick={() => handlePageChange(page + 1)}
          >
            ›
          </button>
        </div>
      )}
    </div>
  );
}

export default AdminLogsPanel;
