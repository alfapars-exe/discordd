import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  cancelReminder,
  createReminder,
  listReminders,
  updateReminder,
  type MessageReminder,
  type ReminderSource,
} from "../../api/reminders";
import { useToastStore } from "../../stores/toastStore";
import {useAuthStore} from "../../stores/authStore";
import {getAuthGeneration} from "../../api/client";
import {findReminderAttempt,forgetReminderAttempt,reminderAttempt} from "../../utils/reminderAttempts";
import {SERVER_URL} from "../../utils/constants";

type Props = { source: ReminderSource; onClose: () => void };

const toLocalInput = (date: Date) => {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
};

export default function ReminderModal({ source, onClose }: Props) {
  const owner=useAuthStore(state=>state.user?.id);
  const generation=useAuthStore(()=>getAuthGeneration());
  return <ReminderForContext key={JSON.stringify([owner,generation,source.source_kind,source.server_id,source.channel_id,source.message_id])} source={source} onClose={onClose} owner={owner} generation={generation}/>;
}

function ReminderForContext({source,onClose,owner,generation}:Props&{owner?:string;generation:number}) {
  const { t, i18n } = useTranslation("chat");
  const dialogRef = useRef<HTMLDivElement>(null);
  const dueRef = useRef<HTMLInputElement>(null);
  const closeRef = useRef(onClose);
  const titleId = useId(), dueId = useId();
  useLayoutEffect(() => { closeRef.current = onClose; }, [onClose]);
  useLayoutEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    const visible = (element: HTMLElement) => {
      for (let node: HTMLElement | null = element; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (node.hidden || node.inert || node.getAttribute("aria-hidden") === "true" || style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return false;
      }
      return true;
    };
    const ownsFocus = () => Array.from(document.querySelectorAll<HTMLElement>('[aria-modal="true"][role="dialog"], [aria-modal="true"][role="alertdialog"]')).filter(visible).at(-1) === dialog;
    const controls = () => Array.from(dialog?.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], [tabindex="0"]') ?? [])
      .filter(element => element.tabIndex >= 0 && !element.matches(":disabled") && visible(element));
    dueRef.current?.focus();
    function keydown(event: KeyboardEvent) {
      if (!ownsFocus() || event.defaultPrevented) return;
      if (event.key === "Escape") {
        event.preventDefault(); event.stopPropagation(); closeRef.current();
      } else if (event.key === "Tab") {
        const available = controls(), first = available[0], last = available.at(-1);
        if (!first) { event.preventDefault(); dialog?.focus(); }
        else if (event.shiftKey && (document.activeElement === first || !dialog?.contains(document.activeElement))) {
          event.preventDefault(); last?.focus();
        } else if (!event.shiftKey && (document.activeElement === last || !dialog?.contains(document.activeElement))) {
          event.preventDefault(); first.focus();
        }
      }
    }
    function contain(event: FocusEvent) {
      if (ownsFocus() && !dialog?.contains(event.target as Node)) (controls()[0] ?? dialog)?.focus();
    }
    document.addEventListener("keydown", keydown, true);
    document.addEventListener("focusin", contain);
    return () => {
      document.removeEventListener("keydown", keydown, true);
      document.removeEventListener("focusin", contain);
      if (previous?.isConnected && (document.activeElement === document.body || dialog?.contains(document.activeElement))) previous.focus();
    };
  }, []);
  const toast = useToastStore((s) => s.addToast);
  const [items, setItems] = useState<MessageReminder[]>([]);
  const [due, setDue] = useState(() => toLocalInput(new Date(Date.now() + 60 * 60_000)));
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const operation=useRef(false),readVersion=useRef(0),active=useRef(true);
  const createAttempt=useRef<{payload:string;requestID:string}|undefined>(undefined);
  const current=useCallback(()=>active.current&&Boolean(owner)&&owner===useAuthStore.getState().user?.id&&generation===getAuthGeneration(),[owner,generation]);

  const reload = useCallback(async () => {
    if(!current())return;
    const version=++readVersion.current;
    try {
      const result = await listReminders({expectedUserId:owner,isCurrent:current});
      if(!current()||version!==readVersion.current)return;
      if (result.success && result.data) setItems(result.data.reminders);
      else toast("error", t("reminderLoadFailed"));
    } catch {if(current()&&version===readVersion.current)toast("error",t("reminderLoadFailed"));}
  }, [t, toast,current,owner]);

  useEffect(() => {
    const mounted=active,versions=readVersion;
    mounted.current=true;
    void Promise.resolve().then(()=>{if(mounted.current)return reload();});
    return()=>{mounted.current=false;++versions.current;};
  }, [reload]);

  const submit = async () => {
    if(operation.current||!current())return;
    const parsed = new Date(due);
    if (!Number.isFinite(parsed.getTime())) {
      toast("warning", t("reminderFutureRequired"));
      return;
    }
    const dueAt=parsed.toISOString();
    const payload=JSON.stringify([source.source_kind,source.server_id??null,source.channel_id,source.message_id,dueAt]);
    setBusy(true);
    operation.current=true;++readVersion.current;
    try {
    const scope=JSON.stringify([SERVER_URL,owner]);
    if(!editing){
      const stored=await findReminderAttempt(scope,payload);
      if(!current())return;
      if(parsed.getTime()<=Date.now()&&!stored){toast("warning",t("reminderFutureRequired"));return;}
      const requestID=stored??await reminderAttempt(scope,payload);
      if(!current())return;
      createAttempt.current={payload,requestID};
    }else if(parsed.getTime()<=Date.now()){toast("warning",t("reminderFutureRequired"));return;}
    const result = editing
      ? await updateReminder(editing, dueAt,{expectedUserId:owner,isCurrent:current})
      : await createReminder({ ...source, due_at: dueAt,request_id:createAttempt.current!.requestID },{expectedUserId:owner,isCurrent:current});
    if(!current())return;
    if (!result.success) { toast("error", t("reminderSaveFailed")); return; }
    toast("success", t(editing ? "reminderUpdated" : result.data&&result.data.status!=="scheduled"?"reminderAlreadyProcessed":"reminderCreated"));
    if(!editing){
      // Cleanup failure must not turn a committed save into a reported failure.
      // Retaining the durable identity makes another exact retry safe.
      try{await forgetReminderAttempt(scope,payload,createAttempt.current!.requestID);createAttempt.current=undefined;}catch{/* Retain retry identity. */}
      if(!current())return;
    }
    setEditing(null);
    await reload();
    } catch {if(current())toast("error",t("reminderSaveFailed"));}
    finally{operation.current=false;if(current())setBusy(false);}
  };

  const remove = async (id: string) => {
    if(operation.current||!current())return;
    operation.current=true;setBusy(true);++readVersion.current;
    try {
    const result = await cancelReminder(id,{expectedUserId:owner,isCurrent:current});
    if(!current())return;
    if (!result.success) { toast("error", t("reminderCancelFailed")); return; }
    setItems((current) => current.filter((item) => item.id !== id));
    if (editing === id) setEditing(null);
    toast("success", t("reminderCancelled"));
    }catch{if(current())toast("error",t("reminderCancelFailed"));}
    finally{operation.current=false;if(current())setBusy(false);}
  };

  return (
    <div className="report-overlay" role="presentation" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={dialogRef} className="report-modal reminder-modal" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <div className="report-header">
          <h2 id={titleId} className="report-title">{t("reminderTitle")}</h2>
          <button className="report-close" onClick={onClose} aria-label={t("reminderClose")}>✕</button>
        </div>
        <div className="report-body">
          <div className="report-field">
            <label className="report-label" htmlFor={dueId}>{t("reminderDue")}</label>
            <input ref={dueRef} id={dueId} className="reminder-datetime" type="datetime-local" value={due} min={toLocalInput(new Date())} onChange={(e) => setDue(e.target.value)} />
            <div className="reminder-presets">
              <button onClick={() => setDue(toLocalInput(new Date(Date.now() + 60 * 60_000)))}>{t("reminderInHour")}</button>
              <button onClick={() => setDue(toLocalInput(new Date(Date.now() + 24 * 60 * 60_000)))}>{t("reminderTomorrow")}</button>
              <button onClick={() => setDue(toLocalInput(new Date(Date.now() + 7 * 24 * 60 * 60_000)))}>{t("reminderNextWeek")}</button>
            </div>
          </div>
          <div className="report-actions reminder-create-actions">
            {editing && <button className="report-btn report-btn-cancel" onClick={() => setEditing(null)}>{t("reminderStopEditing")}</button>}
            <button className="report-btn reminder-save" disabled={busy} onClick={() => { void submit(); }}>{t(editing ? "reminderUpdate" : "reminderCreate")}</button>
          </div>
          <h3 className="reminder-list-title">{t("upcomingReminders")}</h3>
          {items.length === 0 ? <p className="reminder-empty">{t("noUpcomingReminders")}</p> : (
            <div className="reminder-list">
              {items.map((item) => (
                <div className="reminder-row" key={item.id}>
                  <div><strong>{new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium", timeStyle: "short" }).format(new Date(item.due_at))}</strong><span>{item.source_kind === "dm" ? t("directMessages") : t("channelReminder")}</span></div>
                  <div className="reminder-row-actions">
                    <button disabled={busy} onClick={() => { setEditing(item.id); setDue(toLocalInput(new Date(item.due_at))); }}>{t("reminderEdit")}</button>
                    <button disabled={busy} className="destructive" onClick={() => { void remove(item.id); }}>{t("reminderCancel")}</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
