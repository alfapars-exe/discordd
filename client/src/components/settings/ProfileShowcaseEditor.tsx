import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { getAuthGeneration } from "../../api/client";
import * as profileApi from "../../api/profile";
import type { ProfileLink, ProfileShowcase, ProfileWidget, ProfileWidgetType } from "../../api/profile";
import { useServerStore } from "../../stores/serverStore";
import { useToastStore } from "../../stores/toastStore";
import { useAuthStore } from "../../stores/authStore";
import { useSettingsDraft } from "./settingsWorkspaceContext";

const emptyShowcase = (): ProfileShowcase => ({ theme: { primary: "", secondary: "" }, watching: "", widgets: [], links: [], version: 0 });
const widgetTypes: ProfileWidgetType[] = ["favorite_game", "liked_games", "rotation_games", "wishlist", "game_link"];
const makeId = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
const validExternalLink = (value: string) => {
  try {
    const url = new URL(value.trim());
    return (url.protocol === "https:" || url.protocol === "http:") && Boolean(url.hostname) && !url.username && !url.password;
  } catch { return false; }
};
type CachedShowcaseDraft = { base: ProfileShowcase; draft: ProfileShowcase };
type ConflictState = "loading" | "ready" | "error";

export default function ProfileShowcaseEditor() {
  const { t } = useTranslation("settings");
  const addToast = useToastStore((s) => s.addToast);
  const activeServerId = useServerStore((s) => s.activeServerId);
  const activeServer = useServerStore((s) => s.activeServer);
  const accountId = useAuthStore((s) => s.user?.id ?? null);
  const [serverScoped, setServerScoped] = useState(false);
  const scope = serverScoped ? activeServerId : null;
  const scopeUnavailable = serverScoped && !activeServerId;
  const contextKey = JSON.stringify([accountId, scope, scopeUnavailable]);
  const [saved, setSaved] = useState<ProfileShowcase>(emptyShowcase);
  const [draft, setDraft] = useState<ProfileShowcase>(emptyShowcase);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [conflictState, setConflictState] = useState<ConflictState | null>(null);
  const [loadedContextKey, setLoadedContextKey] = useState(contextKey);
  const [invalidLinks, setInvalidLinks] = useState<Set<string>>(new Set());
  const [tab, setTab] = useState<"board" | "activity" | "wishlist">("board");
  const requestSequence = useRef(0);
  const saveSequence = useRef(0);
  const saveInFlight = useRef(false);
  const activeContext = useRef(contextKey);
  const displayedContext = useRef(contextKey);
  const previousAccount = useRef(accountId);
  const draftCache = useRef(new Map<string, CachedShowcaseDraft>());
  const mounted = useRef(true);
  const changed = useMemo(() => JSON.stringify(draft) !== JSON.stringify(saved), [draft, saved]);
  const contextPending = loadedContextKey !== contextKey;
  const latestEditor = useRef({ changed, saved, draft });
  useSettingsDraft(changed || saving);

  useLayoutEffect(() => {
    activeContext.current = contextKey;
    latestEditor.current = { changed, saved, draft };
  }, [contextKey, changed, saved, draft]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const load = useCallback(async () => {
    const request = ++requestSequence.current;
    const requestContext = contextKey;
    const requestAccount = accountId;
    const authGeneration = getAuthGeneration();
    const isCurrent = () => mounted.current && request === requestSequence.current && activeContext.current === requestContext && useAuthStore.getState().user?.id === requestAccount && getAuthGeneration() === authGeneration;
    setLoading(true);
    setLoadError(false);
    setInvalidLinks(new Set());
    if (scopeUnavailable) {
      if (isCurrent()) { setSaved(emptyShowcase()); setDraft(emptyShowcase()); setLoadError(true); }
      if (request === requestSequence.current && mounted.current) setLoading(false);
      return;
    }
    try {
      const res = await profileApi.getProfileShowcase(scope, { expectedUserId: requestAccount ?? undefined, isCurrent });
      if (!isCurrent()) return;
      if (res.success && res.data) {
        setSaved(res.data);
        const cached = draftCache.current.get(requestContext);
        if (cached) {
          setDraft(cached.draft);
          if (cached.base.version === res.data.version) { draftCache.current.delete(requestContext); setConflictState(null); }
          else setConflictState("ready");
        } else { setDraft(res.data); setConflictState(null); }
      }
      else { setSaved(emptyShowcase()); setDraft(emptyShowcase()); setLoadError(true); addToast("error", t("profileShowcaseLoadError")); }
    } catch {
      if (isCurrent()) { setSaved(emptyShowcase()); setDraft(emptyShowcase()); setLoadError(true); addToast("error", t("profileShowcaseLoadError")); }
    } finally {
      if (request === requestSequence.current && mounted.current) setLoading(false);
    }
  }, [accountId, contextKey, scope, scopeUnavailable, addToast, t]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (displayedContext.current !== contextKey) {
        if (previousAccount.current !== accountId) {
          draftCache.current.clear();
          setSaved(emptyShowcase());
          setDraft(emptyShowcase());
        } else if (latestEditor.current.changed) {
          draftCache.current.set(displayedContext.current, { base: latestEditor.current.saved, draft: latestEditor.current.draft });
        }
        displayedContext.current = contextKey;
        previousAccount.current = accountId;
        setLoadedContextKey(contextKey);
        saveSequence.current += 1;
        saveInFlight.current = false;
        setSaving(false);
        setConflictState(null);
      }
      void load();
    }, 0);
    return () => { window.clearTimeout(timer); requestSequence.current += 1; };
  }, [accountId, contextKey, load]);

  const addWidget = (type: ProfileWidgetType) => {
    const widget: ProfileWidget = { id: makeId(), type, title: t(`profileWidget_${type}`), items: [] };
    setDraft((d) => ({ ...d, widgets: [...d.widgets, widget] }));
  };
  const updateWidget = (id: string, patch: Partial<ProfileWidget>) => setDraft((d) => ({ ...d, widgets: d.widgets.map((w) => w.id === id ? { ...w, ...patch } : w) }));
  const moveWidget = (index: number, delta: number) => setDraft((d) => {
    const next = [...d.widgets]; const target = index + delta;
    if (target < 0 || target >= next.length) return d;
    [next[index], next[target]] = [next[target], next[index]];
    return { ...d, widgets: next };
  });
  const addLink = () => setDraft((d) => ({ ...d, links: [...d.links, { id: makeId(), label: "", url: "https://", visible: true }] }));
  const updateLink = (id: string, patch: Partial<ProfileLink>) => {
    setInvalidLinks((current) => { const next = new Set(current); next.delete(id); return next; });
    setDraft((d) => ({ ...d, links: d.links.map((l) => l.id === id ? { ...l, ...patch } : l) }));
  };

  const refreshConflictBase = useCallback(async () => {
    const requestContext = contextKey;
    const requestAccount = accountId;
    const authGeneration = getAuthGeneration();
    const isCurrent = () => mounted.current && activeContext.current === requestContext && useAuthStore.getState().user?.id === requestAccount && getAuthGeneration() === authGeneration;
    setConflictState("loading");
    try {
      const res = await profileApi.getProfileShowcase(scope, { expectedUserId: requestAccount ?? undefined, isCurrent });
      if (!isCurrent()) return;
      if (!res.success || !res.data) { setConflictState("error"); return; }
      setSaved(res.data);
      draftCache.current.set(requestContext, { base: res.data, draft });
      setConflictState("ready");
    } catch {
      if (isCurrent()) setConflictState("error");
    }
  }, [accountId, contextKey, draft, scope]);

  const save = async (overwriteLatest = false) => {
    if (!changed || saving || saveInFlight.current || loading || contextPending || scopeUnavailable || (conflictState !== null && !(overwriteLatest && conflictState === "ready"))) return;
    const badLinks = draft.links.filter((link) => !link.label.trim() || !validExternalLink(link.url)).map((link) => link.id);
    if (badLinks.length) { setInvalidLinks(new Set(badLinks)); addToast("error", t("profileShowcaseSaveError")); return; }
    const requestContext = contextKey;
    const requestAccount = accountId;
    const authGeneration = getAuthGeneration();
    const snapshot = draft;
    const isCurrent = () => mounted.current && activeContext.current === requestContext && useAuthStore.getState().user?.id === requestAccount && getAuthGeneration() === authGeneration;
    const saveRequest = ++saveSequence.current;
    saveInFlight.current = true;
    setSaving(true);
    try {
      const res = await profileApi.saveProfileShowcase(snapshot, saved.version, scope, { expectedUserId: requestAccount ?? undefined, isCurrent });
      if (!isCurrent()) return;
      if (res.success && res.data) {
        draftCache.current.delete(requestContext);
        setConflictState(null);
        setSaved(res.data);
        setDraft((current) => JSON.stringify(current) === JSON.stringify(snapshot) ? res.data! : current);
        addToast("success", t("profileShowcaseSaved"));
      } else {
        if (res.code === "VERSION_CONFLICT") {
          addToast("error", t("profileShowcaseConflict"));
          await refreshConflictBase();
        } else addToast("error", t("profileShowcaseSaveError"));
      }
    } catch {
      if (isCurrent()) addToast("error", t("profileShowcaseSaveError"));
    } finally {
      if (saveRequest === saveSequence.current) {
        saveInFlight.current = false;
        if (mounted.current) setSaving(false);
      }
    }
  };

  return <section className="profile-showcase-editor" aria-busy={loading || contextPending}>
    <div className="settings-separator" />
    <h3>{t("profileShowcase")}</h3>
    <div className="profile-scope-row">
      <button type="button" disabled={saving || changed} className={!serverScoped ? "settings-btn" : "settings-btn settings-btn-secondary"} onClick={() => setServerScoped(false)}>{t("profileScopeGlobal")}</button>
      <button type="button" disabled={!activeServerId || saving || changed} className={serverScoped ? "settings-btn" : "settings-btn settings-btn-secondary"} onClick={() => setServerScoped(true)}>{t("profileScopeServer", { name: activeServer?.name ?? "" })}</button>
    </div>
    {loading || contextPending ? <p>{t("loading")}</p> : loadError ? <div role="alert">{t("profileShowcaseLoadError")} <button type="button" onClick={() => void load()}>{t("errorBoundary.retry", { ns: "common" })}</button></div> : <div className="profile-showcase-grid">
      <div className="profile-showcase-controls">
        <label className="settings-label">{t("profileThemeColors")}</label>
        <div className="profile-color-row"><input type="color" value={draft.theme.primary || "#5865f2"} onChange={(e) => setDraft({ ...draft, theme: { ...draft.theme, primary: e.target.value } })}/><input type="color" value={draft.theme.secondary || "#2b2d31"} onChange={(e) => setDraft({ ...draft, theme: { ...draft.theme, secondary: e.target.value } })}/></div>
        <label className="settings-label">{t("profileWatching")}</label>
        <input aria-label={t("profileWatching")} className="settings-input" maxLength={80} value={draft.watching ?? ""} onChange={(e) => setDraft({ ...draft, watching: e.target.value })}/>
        <label className="settings-label">{t("profileWidgetLibrary")}</label>
        <div className="profile-widget-library">{widgetTypes.map((type) => <button type="button" className="settings-btn settings-btn-secondary" key={type} disabled={draft.widgets.length >= 12} onClick={() => addWidget(type)}>+ {t(`profileWidget_${type}`)}</button>)}</div>
        <button type="button" className="settings-btn settings-btn-secondary" disabled={draft.links.length >= 12} onClick={addLink}>+ {t("profileManualLink")}</button>
      </div>
      <div className="profile-showcase-preview" style={{ background: `linear-gradient(145deg, ${draft.theme.primary || "#17181c"}, ${draft.theme.secondary || "#0f1012"})` }}>
        <div className="profile-board-tabs" role="tablist">{(["board", "activity", "wishlist"] as const).map((item) => <button type="button" role="tab" aria-selected={tab === item} key={item} onClick={() => setTab(item)}>{t(`profileTab_${item}`)}</button>)}</div>
        {tab === "activity" ? <p>{draft.watching || t("profileNoActivity")}</p> : <div className="profile-widget-list">{draft.widgets.map((widget, index) => ({ widget, index })).filter(({ widget }) => tab !== "wishlist" || widget.type === "wishlist").map(({ widget: w, index }) => <article className="profile-widget-card" key={w.id}>
          <input aria-label={t("profileWidgetTitle")} className="settings-input" value={w.title ?? ""} onChange={(e) => updateWidget(w.id, { title: e.target.value })}/>
          <input aria-label={t("profileWidgetItems")} className="settings-input" value={(w.items ?? []).join(", ")} onChange={(e) => updateWidget(w.id, { items: e.target.value.split(",").map((v) => v.trim()).filter(Boolean) })}/>
          {w.type === "game_link" && <input aria-label={t("profileLinkUrl")} className="settings-input" value={w.url ?? ""} placeholder="https://" onChange={(e) => updateWidget(w.id, { url: e.target.value })}/>} 
          <div><button type="button" className="settings-btn settings-btn-secondary" aria-label={t("profileWidgetMoveUp", { name: w.title || t(`profileWidget_${w.type}`) })} onClick={() => moveWidget(index, -1)} disabled={index === 0}>↑</button><button type="button" className="settings-btn settings-btn-secondary" aria-label={t("profileWidgetMoveDown", { name: w.title || t(`profileWidget_${w.type}`) })} onClick={() => moveWidget(index, 1)} disabled={index === draft.widgets.length - 1}>↓</button><button type="button" className="settings-btn settings-btn-secondary" onClick={() => setDraft((d) => ({ ...d, widgets: d.widgets.filter((x) => x.id !== w.id) }))}>{t("remove", { ns: "common" })}</button></div>
        </article>)}</div>}
        <div className="profile-links-list">{draft.links.map((l) => <div className="profile-link-editor" key={l.id}><input aria-label={t("profileLinkLabel")} aria-invalid={invalidLinks.has(l.id) && !l.label.trim()} className="settings-input" placeholder={t("profileLinkLabel")} value={l.label} onChange={(e) => updateLink(l.id, { label: e.target.value })}/><input aria-label={t("profileLinkUrl")} aria-invalid={invalidLinks.has(l.id) && !validExternalLink(l.url)} className="settings-input" placeholder="https://" value={l.url} onChange={(e) => updateLink(l.id, { url: e.target.value })}/><label><input type="checkbox" checked={l.visible} onChange={(e) => updateLink(l.id, { visible: e.target.checked })}/> {t("profileLinkVisible")}</label><button type="button" className="settings-btn settings-btn-secondary" onClick={() => setDraft((d) => ({ ...d, links: d.links.filter((x) => x.id !== l.id) }))}>{t("remove", { ns: "common" })}</button></div>)}</div>
      </div>
      <div className="profile-showcase-summary"><strong>{t("profileLivePreview")}</strong><p>{draft.widgets.length} {t("profileWidgets")}</p><p>{draft.links.filter((l) => l.visible).length} {t("profileLinks")}</p><p>{t("profileAllFree")}</p></div>
    </div>}
    {conflictState && <div role="alert" className="profile-showcase-conflict">{t("profileShowcaseConflict")} {conflictState === "loading" && <span>{t("loading")}</span>}{conflictState === "error" && <button type="button" onClick={() => void refreshConflictBase()}>{t("errorBoundary.retry", { ns: "common" })}</button>}{conflictState === "ready" && <><button type="button" disabled={saving} onClick={() => void save(true)}>{t("profileShowcaseOverwrite")}</button><button type="button" disabled={saving} onClick={() => { draftCache.current.delete(contextKey); setDraft(saved); setConflictState(null); }}>{t("profileShowcaseDiscardDraft")}</button></>}</div>}
    <div className="profile-showcase-save"><button type="button" className="settings-btn" disabled={!changed || saving || loading || contextPending || scopeUnavailable || loadError || conflictState !== null} onClick={() => void save()}>{saving ? `${t("saveChanges")}...` : t("saveChanges")}</button>{changed && <button type="button" className="settings-btn settings-btn-secondary" disabled={saving} onClick={() => { draftCache.current.delete(contextKey); setDraft(saved); setConflictState(null); }}>{t("cancel")}</button>}</div>
  </section>;
}
