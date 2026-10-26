import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { getAuthGeneration } from "../../api/client";
import {
  cancelServerEvent,
  createServerEvent,
  getServerEvent,
  listServerEvents,
  setServerEventInterested,
  updateServerEvent,
  type CreateServerEventRequest,
  type ServerEvent,
} from "../../api/serverEvents";
import { useAuthStore } from "../../stores/authStore";
import { useChannelStore } from "../../stores/channelStore";
import { useMemberStore } from "../../stores/memberStore";
import { useServerStore } from "../../stores/serverStore";
import { hasPermission, Permissions } from "../../utils/permissions";

type Props = { serverId: string; serverName: string; onClose: () => void; initialEventId?: string };
type Draft = { name: string; description: string; startsAt: string; endsAt: string; channelId: string };
const PAGE_SIZE = 50;
const EMPTY_DRAFT: Draft = { name: "", description: "", startsAt: "", endsAt: "", channelId: "" };

function toLocalInput(value?: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function asRequest(draft: Draft): CreateServerEventRequest {
  return {
    name: draft.name.trim(),
    description: draft.description.trim(),
    starts_at: new Date(draft.startsAt).toISOString(),
    ...(draft.endsAt ? { ends_at: new Date(draft.endsAt).toISOString() } : {}),
    ...(draft.channelId ? { channel_id: draft.channelId } : {}),
  };
}

function errorText(result: { error?: string; code?: string; status?: number }): string {
  return result.code || result.error || (result.status ? `HTTP ${result.status}` : "unknown");
}

function runeCount(value: string): number {
  return Array.from(value).length;
}

function ServerEventsModal({ serverId, serverName, onClose, initialEventId }: Props) {
  const { t } = useTranslation("servers");
  const accountId = useAuthStore((s) => s.user?.id ?? null);
  const activeServerId = useServerStore((s) => s.activeServerId);
  // Derive permission from the member cached for this exact server, never another active server.
  const currentMember = useMemberStore((s) => s.membersByServer[serverId]?.find((item) => item.id === accountId));
  const canManage = !!currentMember && hasPermission(currentMember.effective_permissions, Permissions.ManageEvents);
  const categories = useChannelStore((s) => s.categoriesByServer[serverId] ?? []);
  const channels = categories.flatMap((category) => category.channels).filter((channel) => channel.type !== "thread");

  const [events, setEvents] = useState<ServerEvent[]>([]);
  const [eventsOwner, setEventsOwner] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState("");
  const [errorOwner, setErrorOwner] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingVersion, setEditingVersion] = useState<number | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorOwner, setEditorOwner] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [busyEventId, setBusyEventId] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [targetEvent, setTargetEvent] = useState<ServerEvent | null>(null);
  const [targetOwner, setTargetOwner] = useState<string | null>(null);
  const [targetLoading, setTargetLoading] = useState(false);
  const [targetError, setTargetError] = useState("");
  const [targetErrorId, setTargetErrorId] = useState<string | undefined>(undefined);
  const [targetErrorOwner, setTargetErrorOwner] = useState<string | null>(null);
  const [targetRetry, setTargetRetry] = useState(0);
  const mounted = useRef(false);
  const lastEventId = useRef<string | undefined>(undefined);
  const listRequestId = useRef(0);
  const detailRequestId = useRef(0);
  const targetArticle = useRef<HTMLElement | null>(null);
  const reportError = useCallback((message: string, owner: string | null = accountId) => {
    setError(message);
    setErrorOwner(owner);
  }, [accountId]);
  const clearError = useCallback(() => reportError(""), [reportError]);

  const isCurrent = useCallback((owner: string | null, generation: number) => {
    return mounted.current && getAuthGeneration() === generation &&
      useAuthStore.getState().user?.id === owner &&
      useServerStore.getState().activeServerId === serverId;
  }, [serverId]);

  useEffect(() => {
    mounted.current = true;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      mounted.current = false;
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  useEffect(() => {
    const upcomingStarts = [...events, ...(targetOwner === accountId && targetEvent ? [targetEvent] : [])]
      .filter((item) => item.status === "scheduled" && !item.interested)
      .map((item) => Date.parse(item.starts_at))
      .filter((startsAt) => startsAt > Date.now());
    if (upcomingStarts.length === 0) return;
    const nextStart = Math.min(...upcomingStarts);
    const delay = Math.min(nextStart - Date.now() + 1, 2_147_483_647);
    const timer = window.setTimeout(() => setNow(Date.now()), delay);
    return () => window.clearTimeout(timer);
  }, [accountId, events, now, targetEvent, targetOwner]);

  useEffect(() => {
    if (activeServerId !== serverId) onClose();
  }, [activeServerId, onClose, serverId]);

  const loadEvents = useCallback(async (append = false) => {
    const owner = accountId;
    const generation = getAuthGeneration();
    if (!owner || !isCurrent(owner, generation)) return;
    const requestId = ++listRequestId.current;
    if (append) setLoadingMore(true);
    else {
      setLoading(true);
      setLoadingMore(false);
    }
    clearError();
    try {
      const beforeId = append ? lastEventId.current : undefined;
      const result = await listServerEvents(serverId, { limit: PAGE_SIZE, beforeId }, {
        expectedUserId: owner,
        isCurrent: () => isCurrent(owner, generation),
      });
      if (!isCurrent(owner, generation) || requestId !== listRequestId.current) return;
      if (!result.success || !result.data) {
        reportError(errorText(result), owner);
        return;
      }
      const page = result.data.events ?? [];
      lastEventId.current = page.at(-1)?.id;
      setEventsOwner(owner);
      setEvents((current) => append ? [...current, ...page.filter((event) => !current.some((item) => item.id === event.id))] : page);
      setHasMore(page.length === PAGE_SIZE);
    } catch (cause) {
      if (isCurrent(owner, generation) && requestId === listRequestId.current) {
        reportError(cause instanceof Error ? cause.message : "unknown", owner);
      }
    } finally {
      if (isCurrent(owner, generation) && requestId === listRequestId.current) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, [accountId, clearError, isCurrent, reportError, serverId]);

  useEffect(() => {
    // Data loading is an external synchronization effect; state updates happen when the request settles.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadEvents(false);
  }, [accountId, loadEvents]);

  useEffect(() => {
    if (!initialEventId) return;
    const owner = accountId;
    const generation = getAuthGeneration();
    if (!owner || !isCurrent(owner, generation)) return;
    const requestId = ++detailRequestId.current;
    // This is an external fetch synchronization; its result updates local display state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTargetLoading(true);
    setTargetError("");
    setTargetErrorId(undefined);
    void getServerEvent(serverId, initialEventId, {
      expectedUserId: owner,
      isCurrent: () => isCurrent(owner, generation),
    }).then((result) => {
      if (!isCurrent(owner, generation) || requestId !== detailRequestId.current) return;
      if (!result.success || !result.data) {
        setTargetError(errorText(result));
        setTargetErrorId(initialEventId);
        setTargetErrorOwner(owner);
      }
      else {
        setTargetEvent(result.data);
        setTargetOwner(owner);
      }
    }).catch((cause: unknown) => {
      if (isCurrent(owner, generation) && requestId === detailRequestId.current) {
        setTargetError(cause instanceof Error ? cause.message : "unknown");
        setTargetErrorId(initialEventId);
        setTargetErrorOwner(owner);
      }
    }).finally(() => {
      if (isCurrent(owner, generation) && requestId === detailRequestId.current) setTargetLoading(false);
    });
  }, [accountId, initialEventId, isCurrent, serverId, targetRetry]);

  useEffect(() => {
    if (initialEventId && ((targetOwner === accountId && targetEvent?.id === initialEventId) || events.some((item) => item.id === initialEventId))) {
      targetArticle.current?.focus();
      targetArticle.current?.scrollIntoView?.({ block: "center" });
    }
  }, [accountId, events, initialEventId, targetEvent, targetOwner]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose, saving]);

  function beginCreate() {
    setEditingId(null);
    setEditingVersion(null);
    setEditorOpen(true);
    setEditorOwner(accountId);
    setDraft(EMPTY_DRAFT);
    setConflict(false);
    clearError();
  }

  function beginEdit(event: ServerEvent) {
    setEditingId(event.id);
    setEditingVersion(event.version);
    setEditorOpen(true);
    setEditorOwner(accountId);
    setDraft({ name: event.name, description: event.description, startsAt: toLocalInput(event.starts_at), endsAt: toLocalInput(event.ends_at), channelId: event.channel_id ?? "" });
    setConflict(false);
    clearError();
  }

  function closeEditor() {
    setEditingId(null);
    setEditingVersion(null);
    setEditorOpen(false);
    setDraft(EMPTY_DRAFT);
    setConflict(false);
    clearError();
  }

  async function saveDraft(event: React.FormEvent) {
    event.preventDefault();
    const nameLength = runeCount(draft.name.trim());
    const descriptionLength = runeCount(draft.description.trim());
    if (saving || !canManage || nameLength === 0 || nameLength > 100 || descriptionLength > 2000 || !draft.startsAt) return;
    const owner = accountId;
    const generation = getAuthGeneration();
    if (!owner || !isCurrent(owner, generation)) return;
    const editTarget = editingId ? events.find((item) => item.id === editingId) ?? (targetEvent?.id === editingId ? targetEvent : undefined) : undefined;
    if (editingId && (!editTarget || editingVersion === null)) return;
    setSaving(true);
    clearError();
    setConflict(false);
    try {
      const context = { expectedUserId: owner, isCurrent: () => isCurrent(owner, generation) };
      const result = editingId
        ? await updateServerEvent(serverId, editingId, { ...asRequest(draft), expected_version: editingVersion! }, context)
        : await createServerEvent(serverId, asRequest(draft), context);
      if (!isCurrent(owner, generation)) return;
      if (!result.success || !result.data) {
        const code = result.code ?? "";
        setConflict(result.status === 409 || code.includes("CONFLICT"));
        reportError(errorText(result), owner);
        return;
      }
      closeEditor();
      if (editingId) {
        setEvents((current) => current.map((item) => item.id === result.data!.id ? result.data! : item));
        setTargetEvent((current) => current?.id === result.data!.id ? result.data! : current);
      }
      else await loadEvents(false);
    } catch (cause) {
      if (isCurrent(owner, generation)) reportError(cause instanceof Error ? cause.message : "unknown", owner);
    } finally {
      if (isCurrent(owner, generation)) setSaving(false);
    }
  }

  function acceptLatestVersion() {
    const latest = editingId ? events.find((item) => item.id === editingId) ?? (targetEvent?.id === editingId ? targetEvent : undefined) : undefined;
    if (!latest || editingVersion === null || latest.version === editingVersion) return;
    setEditingVersion(latest.version);
    setConflict(false);
    clearError();
  }

  async function reloadConflictTarget() {
    const editId = editingId;
    const owner = accountId;
    const generation = getAuthGeneration();
    if (!editId || !owner || !isCurrent(owner, generation)) return;
    await loadEvents(false);
    const requestId = ++detailRequestId.current;
    setTargetLoading(true);
    try {
      const result = await getServerEvent(serverId, editId, { expectedUserId: owner, isCurrent: () => isCurrent(owner, generation) });
      if (!isCurrent(owner, generation) || requestId !== detailRequestId.current) return;
      if (!result.success || !result.data) reportError(errorText(result), owner);
      else {
        setTargetEvent(result.data);
        setTargetOwner(owner);
        setEvents((current) => current.map((item) => item.id === editId ? result.data! : item));
      }
    } catch (cause) {
      if (isCurrent(owner, generation) && requestId === detailRequestId.current) reportError(cause instanceof Error ? cause.message : "unknown", owner);
    } finally {
      if (isCurrent(owner, generation) && requestId === detailRequestId.current) setTargetLoading(false);
    }
  }

  async function cancelEvent(event: ServerEvent) {
    if (!canManage || busyEventId || event.status !== "scheduled") return;
    if (!window.confirm(t("eventCancelConfirm", { name: event.name }))) return;
    const owner = accountId;
    const generation = getAuthGeneration();
    if (!owner || !isCurrent(owner, generation)) return;
    setBusyEventId(event.id);
    clearError();
    try {
      const result = await cancelServerEvent(serverId, event.id, event.version, { expectedUserId: owner, isCurrent: () => isCurrent(owner, generation) });
      if (!isCurrent(owner, generation)) return;
      if (!result.success || !result.data) {
        setConflict(result.status === 409 || (result.code ?? "").includes("CONFLICT"));
        reportError(errorText(result), owner);
      } else {
        setEvents((current) => current.map((item) => item.id === event.id ? result.data! : item));
        setTargetEvent((current) => current?.id === event.id ? result.data! : current);
      }
    } catch (cause) {
      if (isCurrent(owner, generation)) reportError(cause instanceof Error ? cause.message : "unknown", owner);
    } finally {
      if (isCurrent(owner, generation)) setBusyEventId(null);
    }
  }

  async function toggleInterested(event: ServerEvent) {
    if (busyEventId) return;
    if (!event.interested && Date.parse(event.starts_at) <= Date.now()) return;
    const owner = accountId;
    const generation = getAuthGeneration();
    if (!owner || !isCurrent(owner, generation)) return;
    setBusyEventId(event.id);
    clearError();
    try {
      const result = await setServerEventInterested(serverId, event.id, !event.interested, { expectedUserId: owner, isCurrent: () => isCurrent(owner, generation) });
      if (!isCurrent(owner, generation)) return;
      if (!result.success || !result.data) reportError(errorText(result), owner);
      else {
        setEvents((current) => current.map((item) => item.id === event.id ? { ...item, interested: result.data!.interested } : item));
        setTargetEvent((current) => current?.id === event.id ? { ...current, interested: result.data!.interested } : current);
      }
    } catch (cause) {
      if (isCurrent(owner, generation)) reportError(cause instanceof Error ? cause.message : "unknown", owner);
    } finally {
      if (isCurrent(owner, generation)) setBusyEventId(null);
    }
  }

  function eventActions(item: ServerEvent) {
    return <div className="server-event-actions">{canManage && item.status === "scheduled" && <><button onClick={() => beginEdit(item)} disabled={!!busyEventId}>{t("eventEdit")}</button><button onClick={() => void cancelEvent(item)} disabled={!!busyEventId}>{busyEventId === item.id ? t("eventSaving") : t("eventCancel")}</button></>}{item.status === "scheduled" && (item.interested || Date.parse(item.starts_at) > now) && <button onClick={() => void toggleInterested(item)} disabled={!!busyEventId}>{busyEventId === item.id ? t("eventSaving") : t(item.interested ? "eventInterested" : "eventInterestedAction")}</button>}</div>;
  }

  const nameLength = runeCount(draft.name.trim());
  const descriptionLength = runeCount(draft.description.trim());
  const formIsValid = nameLength > 0 && nameLength <= 100 && descriptionLength <= 2000 && !!draft.startsAt;
  const latestEditingEvent = editingId ? events.find((item) => item.id === editingId) ?? (targetEvent?.id === editingId ? targetEvent : undefined) : undefined;
  const form = <form className="server-event-form" onSubmit={(event) => void saveDraft(event)}>
    <label>{t("eventName")} ({nameLength}/100)<input aria-label={t("eventName")} required aria-invalid={nameLength > 100} value={draft.name} onChange={(event) => setDraft((value) => ({ ...value, name: event.target.value }))} /></label>
    <label>{t("eventDescription")} ({descriptionLength}/2000)<textarea aria-label={t("eventDescription")} aria-invalid={descriptionLength > 2000} value={draft.description} onChange={(event) => setDraft((value) => ({ ...value, description: event.target.value }))} /></label>
    <label>{t("eventStartsAt")}<input required type="datetime-local" value={draft.startsAt} onChange={(event) => setDraft((value) => ({ ...value, startsAt: event.target.value }))} /></label>
    <label>{t("eventEndsAt")}<input type="datetime-local" value={draft.endsAt} onChange={(event) => setDraft((value) => ({ ...value, endsAt: event.target.value }))} /></label>
    <label>{t("eventChannel")}<select value={draft.channelId} onChange={(event) => setDraft((value) => ({ ...value, channelId: event.target.value }))}><option value="">{t("eventNoChannel")}</option>{channels.map((channel) => <option key={channel.id} value={channel.id}>{channel.name}</option>)}</select></label>
    {((error && errorOwner === accountId) || conflict) && <div className="server-event-error" role="alert"><span>{conflict ? t("eventVersionConflict") : t("eventRequestFailed", { reason: error })}</span>{conflict && editingId && <><button type="button" onClick={() => void reloadConflictTarget()} disabled={loading || targetLoading}>{t("eventReloadList")}</button>{latestEditingEvent && latestEditingEvent.version !== editingVersion && <button type="button" onClick={acceptLatestVersion}>{t("eventUseLatestVersion")}</button>}</>}</div>}
    <div className="server-event-form-actions"><button type="button" onClick={closeEditor} disabled={saving}>{t("eventCancelEdit")}</button><button type="submit" disabled={saving || !formIsValid}>{saving ? t("eventSaving") : t("eventSave")}</button></div>
  </form>;

  return createPortal(
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) onClose(); }}>
      <section className="modal-card server-events-modal" role="dialog" aria-modal="true" aria-labelledby="server-events-title" onMouseDown={(event) => event.stopPropagation()}>
        <header className="modal-header"><div><h2 className="modal-title" id="server-events-title">{t("serverEvents")}</h2><p>{serverName}</p></div><button className="toast-close" onClick={onClose} disabled={saving} aria-label={t("eventClose")}>×</button></header>
        {canManage && !editingId && <div className="server-event-toolbar"><button onClick={beginCreate}>{t("eventCreate")}</button></div>}
        {editorOpen && editorOwner === accountId && canManage ? form : null}
        {error && errorOwner === accountId && !(editorOpen && editorOwner === accountId) && <div className="server-event-error" role="alert"><span>{conflict ? t("eventVersionConflict") : t("eventRequestFailed", { reason: error })}</span><button onClick={() => void loadEvents(false)} disabled={loading}>{t("eventRetry")}</button></div>}
        <div className="server-event-list" aria-live="polite">
          {initialEventId && targetLoading && <p>{t("eventLoading")}</p>}
          {initialEventId && targetError && targetErrorId === initialEventId && targetErrorOwner === accountId && <div className="server-event-error" role="alert"><span>{t("eventRequestFailed", { reason: targetError })}</span><button onClick={() => setTargetRetry((value) => value + 1)}>{t("eventRetry")}</button></div>}
          {initialEventId && targetOwner === accountId && targetEvent?.id === initialEventId && !(eventsOwner === accountId && events.some((item) => item.id === initialEventId)) && <article className="server-event-item server-event-target" tabIndex={-1} ref={targetArticle}><div className="server-event-content"><h3>{targetEvent.name}</h3><p>{targetEvent.description || t("eventNoDescription")}</p><time dateTime={targetEvent.starts_at}>{new Date(targetEvent.starts_at).toLocaleString()}</time><span className={`server-event-status ${targetEvent.status}`}>{t(targetEvent.status === "cancelled" ? "eventCancelled" : "eventScheduled")}</span></div>{eventActions(targetEvent)}</article>}
          {loading || (accountId !== null && eventsOwner !== accountId && errorOwner !== accountId) ? <p>{t("eventLoading")}</p> : eventsOwner !== accountId && errorOwner === accountId ? null : events.length === 0 ? (initialEventId && (targetLoading || (targetErrorId === initialEventId && targetErrorOwner === accountId) || (targetOwner === accountId && targetEvent?.id === initialEventId)) ? null : <p>{t("eventEmpty")}</p>) : events.map((item) => <article className={`server-event-item${item.id === initialEventId ? " server-event-target" : ""}`} key={item.id} ref={item.id === initialEventId ? targetArticle : undefined} tabIndex={item.id === initialEventId ? -1 : undefined}>
            <div className="server-event-content"><h3>{item.name}</h3><p>{item.description || t("eventNoDescription")}</p><time dateTime={item.starts_at}>{new Date(item.starts_at).toLocaleString()}</time>{item.ends_at && <span> – {new Date(item.ends_at).toLocaleString()}</span>}<span className={`server-event-status ${item.status}`}>{t(item.status === "cancelled" ? "eventCancelled" : "eventScheduled")}</span>{item.channel_id && <span className="server-event-channel">{channels.find((channel) => channel.id === item.channel_id)?.name ?? item.channel_id}</span>}</div>
            {eventActions(item)}
          </article>)}
        </div>
        {hasMore && eventsOwner === accountId && <button className="server-event-load-more" onClick={() => void loadEvents(true)} disabled={loadingMore}>{loadingMore ? t("eventLoading") : t("eventLoadMore")}</button>}
      </section>
    </div>,
    document.body,
  );
}

export default ServerEventsModal;
