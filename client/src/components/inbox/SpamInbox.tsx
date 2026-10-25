import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { listSpam, decideSpam, type SpamEntry } from "../../api/spam";
import { useAuthStore } from "../../stores/authStore";
import { usePreferencesStore } from "../../stores/preferencesStore";
import { useUIStore } from "../../stores/uiStore";
import { useOpenAtMessage } from "../../hooks/useOpenAtMessage";
import { useSpamDecisionStore } from "../../stores/spamDecisionStore";
import ReportModal from "../shared/ReportModal";
import { getAuthGeneration } from "../../api/client";

export default function SpamInbox() {
  const userId = useAuthStore((s) => s.user?.id);
  const generation = useAuthStore(() => getAuthGeneration());
  return <SpamInboxForAccount key={`${userId ?? "signed-out"}:${generation}`} />;
}

function SpamInboxForAccount() {
  const { t } = useTranslation("inbox");
  const userId = useAuthStore((s) => s.user?.id);
  const generation = getAuthGeneration();
  const decisions = useSpamDecisionStore((s) => s.decisions);
  const decisionAccount = useSpamDecisionStore((s) => s.accountId);
  const decisionSyncError = useSpamDecisionStore((s) => s.syncError);
  const [entries, setEntries] = useState<SpamEntry[]>([]);
  const [cursor, setCursor] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [reporting, setReporting] = useState<SpamEntry | null>(null);
  const epoch = useRef(0);
  const paging = useRef<AbortController | null>(null);
  const action = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; action.current?.abort(); };
  }, []);
  const currentSession = () => mounted.current && useAuthStore.getState().user?.id === userId && getAuthGeneration() === generation;
  const { openAtMessage, openAtDMMessage } = useOpenAtMessage();
  useEffect(() => {
    const version = ++epoch.current;
    paging.current?.abort(); paging.current = null;
    const controller = new AbortController();
    const current = () => !controller.signal.aborted && version === epoch.current && useAuthStore.getState().user?.id === userId && getAuthGeneration() === generation;
    void listSpam("", controller.signal, current).then((response) => {
      if (!current()) return;
      setLoading(false);
      setError(!response.success || !response.data);
      if (response.success && response.data) { setEntries(response.data.entries); setCursor(response.data.next_cursor ?? ""); }
    }).catch(() => { if (current()) { setLoading(false); setError(true); } });
    return () => { controller.abort(); paging.current?.abort(); };
  }, [userId, generation, reload]);
  async function more() {
    if (loading || paging.current) return;
    const version = epoch.current;
    const controller = new AbortController(); paging.current = controller;
    const current = () => currentSession() && !controller.signal.aborted && version === epoch.current;
    setLoading(true);
    try {
      const response = await listSpam(cursor, controller.signal, current);
      if (!current()) return;
      setLoading(false); setError(!response.success || !response.data);
      if (response.success && response.data) { setEntries((previous) => [...previous, ...response.data!.entries.filter((item) => !previous.some((old) => old.source_kind === item.source_kind && old.message_id === item.message_id))]); setCursor(response.data.next_cursor ?? ""); }
    } catch { if (current()) { setLoading(false); setError(true); } }
    finally { if (paging.current === controller) paging.current = null; }
  }
  async function decide(entry: SpamEntry, decision: "restore" | "dismiss") {
    if (action.current || !currentSession()) return;
    const controller = new AbortController(); action.current = controller;
    const current = () => currentSession() && !controller.signal.aborted;
    const key = `${entry.source_kind}:${entry.message_id}`; setPending(key);
    try {
      const response = await decideSpam(entry, decision, { signal: controller.signal, isCurrent: current });
      if (!current()) return;
      setPending(null); setError(!response.success);
      if (!response.success) return;
      // Commit locally as well: the matching socket event can be delayed or lost.
      if (userId) useSpamDecisionStore.getState().apply({ user_id: userId, source_kind: entry.source_kind, message_id: entry.message_id, revision: entry.revision, status: decision === "restore" ? "restored" : "dismissed" });
      const preferences = usePreferencesStore.getState();
      if (decision === "restore" && preferences.accountId === userId) preferences.set({ privacy: { spamRestoredMessages: { [entry.message_id]: entry.revision } } });
      setEntries((items) => items.filter((item) => `${item.source_kind}:${item.message_id}` !== key || item.revision !== entry.revision));
    } catch { if (current()) { setPending(null); setError(true); } }
    finally { if (action.current === controller) action.current = null; }
  }
  function open(entry: SpamEntry) {
    if (entry.source_kind === "dm") void openAtDMMessage(entry.channel_id, entry.message_id);
    else if (entry.source_kind === "channel" && entry.server_id) void openAtMessage(entry.server_id, entry.channel_id, entry.message_id);
    else if (entry.source_kind === "group") useUIStore.getState().openTab(entry.channel_id, "group-dm", t("spamGroup"));
  }
  const visibleEntries = entries.filter((entry) => decisionAccount !== userId || decisions[`${entry.source_kind}:${entry.message_id}`]?.revision !== entry.revision);
  return <section aria-label={t("spam")}>
    <h3>{t("spam")}</h3>
    <button type="button" onClick={() => { epoch.current++; setLoading(true); setError(false); setReload((value) => value + 1); void useSpamDecisionStore.getState().refresh(); }}>{t("spamRefresh")}</button>
    {(error || decisionSyncError) && <p role="alert">{t("spamError")}</p>}
    {loading && <p role="status">{t("spamLoading")}</p>}
    {visibleEntries.length === 0 && !error && !loading && <p>{t("spamEmpty")}</p>}
    {visibleEntries.map((entry) => <article key={`${entry.source_kind}:${entry.message_id}`}>
      <p>{entry.unavailable ? t("spamUnavailable") : t("spamReference")}</p>
      <time>{entry.created_at}</time>
      <button type="button" disabled={entry.unavailable} onClick={() => open(entry)}>{t("spamOpen")}</button>
      <button type="button" disabled={!!pending || entry.unavailable} onClick={() => void decide(entry, "restore")}>{t("spamRestore")}</button>
      <button type="button" disabled={!!pending} onClick={() => void decide(entry, "dismiss")}>{t("spamDismiss")}</button>
      <button type="button" disabled={!entry.author_id || entry.unavailable} onClick={() => setReporting(entry)}>{t("spamReport")}</button>
    </article>)}
    {cursor && <button type="button" disabled={loading} onClick={() => void more()}>{t("loadMore")}</button>}
    {reporting?.author_id && <ReportModal key={`${reporting.source_kind}:${reporting.message_id}`} userId={reporting.author_id} username={t("spamAuthor")} initialReason="spam" onClose={() => setReporting(null)} messageEvidence={{ kind: reporting.source_kind, serverId: reporting.server_id, channelId: reporting.channel_id, messageId: reporting.message_id, content: "", encrypted: true }} />}
  </section>;
}
