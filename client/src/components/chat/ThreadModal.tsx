import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { getAuthGeneration } from "../../api/client";
import { createThread, listThreads, setThreadArchived } from "../../api/threads";
import type { Channel } from "../../types";
import { useAuthStore } from "../../stores/authStore";
import { useServerStore } from "../../stores/serverStore";
import { useThreadStore } from "../../stores/threadStore";
import { useToastStore } from "../../stores/toastStore";
import { useUIStore } from "../../stores/uiStore";

type Props = { serverId: string; channelId: string; messageId: string; defaultName: string; onClose: () => void };

export default function ThreadModal({ serverId, channelId, messageId, defaultName, onClose }: Props) {
  const owner = useAuthStore((state) => state.user?.id);
  const generation = useAuthStore(() => getAuthGeneration());
  const scope = JSON.stringify([serverId, channelId, messageId, owner, generation]);
  return <ThreadModalForScope key={scope} {...{ serverId, channelId, messageId, defaultName, onClose, owner, generation }} />;
}

function ThreadModalForScope({ serverId, channelId, messageId, defaultName, onClose, owner, generation }: Props & { owner?: string; generation: number }) {
  const { t } = useTranslation("chat");
  const [name, setName] = useState(defaultName.slice(0, 100));
  const [threads, setThreads] = useState<Channel[]>([]);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [busy, setBusy] = useState(false);
  const remember = useThreadStore((state) => state.remember);
  const active = useRef(true);
  const readVersion = useRef(0);
  const operation = useRef(false);
  const current = useCallback(() => active.current && Boolean(owner) && owner === useAuthStore.getState().user?.id && generation === getAuthGeneration(), [owner, generation]);

  const reload = useCallback(async () => {
    if (!current()) return;
    const version = ++readVersion.current;
    setLoadState("loading");
    try {
      const result = await listThreads(serverId, channelId, true, { expectedUserId: owner, isCurrent: current });
      if (!current() || version !== readVersion.current) return;
      if (!result.success || !result.data) { setLoadState("error"); return; }
      setThreads(result.data.threads.filter((thread) => thread.starter_message_id === messageId));
      setLoadState("ready");
    } catch {
      if (current() && version === readVersion.current) setLoadState("error");
    }
  }, [serverId, channelId, messageId, owner, current]);
  useEffect(() => {
    let mounted = true;
    const versions = readVersion;
    active.current = true;
    void Promise.resolve().then(() => { if (mounted && active.current) return reload(); });
    return () => { mounted = false; active.current = false; ++versions.current; };
  }, [reload]);

  const open = (thread: Channel) => {
    if (!current()) return;
    remember(thread, serverId);
    const server = useServerStore.getState().servers.find((item) => item.id === serverId);
    useUIStore.getState().openTab(thread.id, "text", thread.name, server ? { serverId, serverName: server.name, serverIconUrl: server.icon_url } : undefined);
    onClose();
  };
  const create = async () => {
    if (operation.current || loadState !== "ready" || threads.length > 0 || !name.trim() || !current()) return;
    operation.current = true;
    setBusy(true);
    try {
      const result = await createThread(serverId, channelId, messageId, name.trim(), { expectedUserId: owner, isCurrent: current });
      if (!current()) return;
      if (!result.success || !result.data) { useToastStore.getState().addToast("error", t("threadCreateFailed")); return; }
      useToastStore.getState().addToast("success", t("threadCreated"));
      open(result.data);
    } catch {
      if (current()) useToastStore.getState().addToast("error", t("threadCreateFailed"));
    } finally {
      operation.current = false;
      if (current()) setBusy(false);
    }
  };
  const toggle = async (thread: Channel) => {
    if (operation.current || !current()) return;
    operation.current = true;
    setBusy(true);
    try {
      const result = await setThreadArchived(serverId, thread.id, !thread.archived_at, { expectedUserId: owner, isCurrent: current });
      if (!current()) return;
      if (!result.success || !result.data) { useToastStore.getState().addToast("error", t("threadUpdateFailed")); return; }
      remember(result.data, serverId);
      setThreads((currentThreads) => currentThreads.map((item) => item.id === result.data!.id ? result.data! : item));
    } catch {
      if (current()) useToastStore.getState().addToast("error", t("threadUpdateFailed"));
    } finally {
      operation.current = false;
      if (current()) setBusy(false);
    }
  };

  return <div className="report-overlay" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="report-modal thread-modal" role="dialog" aria-modal="true" aria-labelledby="thread-title">
      <div className="report-header"><h2 id="thread-title" className="report-title">{t("threadTitle")}</h2><button type="button" className="report-close" onClick={onClose}>✕</button></div>
      <div className="report-body">
        {loadState === "loading" ? <p role="status">{t("threadLoading")}</p> : null}
        {loadState === "error" ? <div role="alert"><p>{t("threadLoadFailed")}</p><button type="button" className="report-btn" onClick={() => { void reload(); }}>{t("spamRetry")}</button></div> : null}
        {loadState === "ready" && threads.length === 0 ? <><label className="report-label" htmlFor="thread-name">{t("threadName")}</label><input id="thread-name" className="forward-search" value={name} maxLength={100} onChange={(event) => setName(event.target.value)} autoFocus /><button type="button" className="report-btn thread-create" disabled={busy || !name.trim()} onClick={() => { void create(); }}>{t("threadCreate")}</button></> : null}
        <div className="forward-destinations">{loadState === "ready" && threads.map((thread) => <div className="thread-row" key={thread.id}><button type="button" className="forward-destination" disabled={busy} onClick={() => open(thread)}><span><strong>{thread.name}</strong><small>{thread.archived_at ? t("threadArchived") : t("threadActive")}</small></span><span>{t("threadOpen")}</span></button><button type="button" className="thread-lifecycle" disabled={busy} onClick={() => { void toggle(thread); }}>{thread.archived_at ? t("threadReopen") : t("threadArchive")}</button></div>)}</div>
      </div>
    </div>
  </div>;
}
