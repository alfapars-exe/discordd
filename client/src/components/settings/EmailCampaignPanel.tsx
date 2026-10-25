import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { createEmailCampaignDraft, getEmailCampaignPreview, publishEmailCampaign } from "../../api/emailCampaigns";
import type { EmailCampaignRequestContext } from "../../api/emailCampaigns";
import type { APIResponse } from "../../types/api";
import type { CreateEmailCampaignRequest, EmailCampaignCategory, EmailCampaignPreview } from "../../types/emailCampaign";
import { getAuthGeneration } from "../../api/client";
import { useAuthStore } from "../../stores/authStore";
import { useConfirmStore } from "../../stores/confirmStore";
import { useSettingsDraft } from "./settingsWorkspaceContext";
import { SERVER_URL } from "../../utils/constants";

type PersistedDraft = {
  category: EmailCampaignCategory;
  subject: string;
  body: string;
  expiresLocal: string;
  campaignId: string | null;
};

const DRAFT_KEY_PREFIX = "hichat:platform-email-campaign:";
const CAMPAIGN_CATEGORIES: EmailCampaignCategory[] = ["announcements", "tips", "recommendations"];

function defaultExpiryLocal() {
  const date = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  date.setSeconds(0, 0);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function readPersistedDraft(key: string): PersistedDraft | null {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw || raw.length > 24_000) return null;
    const value = JSON.parse(raw) as Partial<PersistedDraft>;
    if (!CAMPAIGN_CATEGORIES.includes(value.category as EmailCampaignCategory)
      || typeof value.subject !== "string" || typeof value.body !== "string"
      || typeof value.expiresLocal !== "string"
      || Array.from(value.subject).length > 120 || Array.from(value.body).length > 10_000
      || value.expiresLocal.length > 32
      || !(value.campaignId === null || (typeof value.campaignId === "string" && /^ec_[0-9a-f]{32}$/.test(value.campaignId)))) return null;
    return value as PersistedDraft;
  } catch { return null; }
}

function validCampaignInput(category: EmailCampaignCategory, subject: string, body: string, expiresLocal: string): CreateEmailCampaignRequest | null {
  if (!CAMPAIGN_CATEGORIES.includes(category) || !subject || subject.trim() !== subject || Array.from(subject).length > 120
    || !body || body.trim() !== body || [...body].length > 10_000) return null;
  const expires = new Date(expiresLocal);
  const lifetime = expires.getTime() - Date.now();
  if (!Number.isFinite(expires.getTime()) || lifetime < 60 * 60_000 || lifetime > 30 * 24 * 60 * 60_000) return null;
  return { category, subject, body, expires_at: expires.toISOString() };
}

function EmailCampaignPanel() {
  const { t } = useTranslation("settings");
  const { t: tCommon } = useTranslation("common");
  const user = useAuthStore((state) => state.user);
  const userId = user?.id ?? "";
  const isAdmin = user?.is_platform_admin === true;
  const [sessionUserId] = useState(userId);
  const [generation] = useState(getAuthGeneration);
  const liveGeneration = getAuthGeneration();
  const storageKey = sessionUserId ? `${DRAFT_KEY_PREFIX}${SERVER_URL}:${sessionUserId}` : "";
  const [initial] = useState(() => storageKey ? readPersistedDraft(storageKey) : null);
  const [category, setCategory] = useState<EmailCampaignCategory>(initial?.category ?? "announcements");
  const [subject, setSubject] = useState(initial?.subject ?? "");
  const [body, setBody] = useState(initial?.body ?? "");
  const [expiresLocal, setExpiresLocal] = useState(initial?.expiresLocal ?? defaultExpiryLocal);
  const [campaignId, setCampaignId] = useState<string | null>(initial?.campaignId ?? null);
  const [preview, setPreview] = useState<EmailCampaignPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<"validation" | "request" | null>(null);
  const alive = useRef(true);
  const pending = useRef(false);
  const controllers = useRef(new Set<AbortController>());
  const current = useCallback(() => alive.current && !!sessionUserId && getAuthGeneration() === generation
    && useAuthStore.getState().user?.id === sessionUserId && useAuthStore.getState().user?.is_platform_admin === true, [generation, sessionUserId]);

  async function runRequest<T>(invoke: (context: EmailCampaignRequestContext) => Promise<APIResponse<T>>) {
    const controller = new AbortController();
    controllers.current.add(controller);
    try { return await invoke({ isCurrent: current, signal: controller.signal }); }
    finally { controllers.current.delete(controller); }
  }

  useEffect(() => {
    alive.current = true;
    const ownedControllers = controllers.current;
    return () => {
      alive.current = false;
      for (const controller of ownedControllers) controller.abort();
      ownedControllers.clear();
    };
  }, []);

  useEffect(() => {
    if (liveGeneration === generation && userId === sessionUserId && isAdmin) return;
    for (const controller of controllers.current) controller.abort();
    controllers.current.clear();
  }, [generation, isAdmin, liveGeneration, sessionUserId, userId]);

  const hasLocalDraft = !!(subject || body || campaignId);
  useSettingsDraft(hasLocalDraft && preview?.campaign.status !== "published");

  useEffect(() => {
    if (!storageKey || !current()) return;
    try {
      if (!hasLocalDraft) {
        sessionStorage.removeItem(storageKey);
        return;
      }
      sessionStorage.setItem(storageKey, JSON.stringify({ category, subject, body, expiresLocal, campaignId } satisfies PersistedDraft));
    } catch { /* Session storage can be disabled; the unsaved-settings guard still warns on navigation. */ }
  }, [storageKey, hasLocalDraft, category, subject, body, expiresLocal, campaignId, current]);

  async function loadPreview(id: string) {
    if (!current()) return;
    const response = await runRequest((context) => getEmailCampaignPreview(id, context));
    if (!current()) return;
    if (!response.success || !response.data?.campaign) {
      setError("request");
      return;
    }
    setPreview(response.data);
    setCategory(response.data.campaign.category);
    setSubject(response.data.campaign.subject);
    setBody(response.data.campaign.body);
    setExpiresLocal(toLocalInput(response.data.campaign.expires_at));
    setError(null);
  }

  useEffect(() => {
    if (!initial?.campaignId || !isAdmin) return;
    let cancelled = false;
    void runRequest((context) => getEmailCampaignPreview(initial.campaignId!, { ...context, isCurrent: () => !cancelled && current() })).then((response) => {
      if (cancelled || !current()) return;
      if (response.success && response.data?.campaign) setPreview(response.data);
      else setError("request");
    }).catch(() => { if (!cancelled && current()) setError("request"); });
    return () => { cancelled = true; };
    // The settings panel is keyed by the account/session scope and remounts if it changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function createOrPreview() {
    if (pending.current || !current()) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      if (campaignId) {
        await loadPreview(campaignId);
        return;
      }
      const payload = validCampaignInput(category, subject, body, expiresLocal);
      if (!payload) { setError("validation"); return; }
      const response = await runRequest((context) => createEmailCampaignDraft(payload, context));
      if (!current()) return;
      if (!response.success || !response.data?.id || response.data.status !== "draft") {
        setError("request");
        return;
      }
      setCampaignId(response.data.id);
      await loadPreview(response.data.id);
    } catch { if (current()) setError("request"); }
    finally { pending.current = false; if (current()) setBusy(false); }
  }

  async function publish() {
    const id = campaignId;
    if (!id || preview?.campaign.status !== "draft" || pending.current || !current()) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      const approved = await useConfirmStore.getState().open({
        title: t("emailCampaignPublish"),
        message: t("emailCampaignPublishConfirm", { count: preview.eligible_recipients }),
        confirmLabel: t("emailCampaignPublish"),
        cancelLabel: tCommon("cancel"),
        danger: true,
      });
      if (!approved || !current() || campaignId !== id) return;
      const response = await runRequest((context) => publishEmailCampaign(id, context));
      if (!current() || campaignId !== id) return;
      if (response.success && response.data?.id === id && response.data.status === "published") {
        setPreview((value) => value ? { ...value, campaign: response.data!, eligible_recipients: response.data!.recipient_count } : value);
        setError(null);
        return;
      }

      // A timed-out publish may have committed. Reconcile the same immutable ID
      // before offering retry so the UI never creates a second campaign.
      const refreshed = await runRequest((context) => getEmailCampaignPreview(id, context));
      if (!current() || campaignId !== id) return;
      if (refreshed.success && refreshed.data?.campaign.status === "published") {
        setPreview(refreshed.data);
        setError(null);
      } else setError("request");
    } catch { if (current()) setError("request"); }
    finally { pending.current = false; if (current()) setBusy(false); }
  }

  async function resetDraft() {
    if (pending.current || !current()) return;
    if (hasLocalDraft && preview?.campaign.status !== "published") {
      pending.current = true;
      setBusy(true);
      try {
        const discard = await useConfirmStore.getState().open({
          title: t("emailCampaignReset"), message: t("emailCampaignUnsaved"),
          confirmLabel: t("emailCampaignReset"), cancelLabel: tCommon("cancel"), danger: true,
        });
        if (!discard || !current()) return;
      } finally { pending.current = false; if (current()) setBusy(false); }
    }
    if (!current()) return;
    setCampaignId(null);
    setPreview(null);
    setCategory("announcements");
    setSubject("");
    setBody("");
    setExpiresLocal(defaultExpiryLocal());
    setError(null);
  }

  if (!isAdmin || userId !== sessionUserId || getAuthGeneration() !== generation) return null;

  return <section aria-labelledby="settings-email-campaigns">
    <div className="settings-divider" />
    <h2 id="settings-email-campaigns" data-settings-section="email-campaigns" className="settings-section-title">{t("platformEmailCampaigns")}</h2>
    <p className="settings-hint">{t("emailCampaignDescription")}</p>
    <p className="settings-hint">{t("emailCampaignProviderNotice")}</p>
    {error && <p role="alert" className="auth-error">{t(error === "validation" ? "emailCampaignValidation" : "emailCampaignFailure")}</p>}

    {!campaignId && <>
      <div className="settings-field">
        <label htmlFor="email-campaign-category" className="settings-label">{t("emailCampaignCategory")}</label>
        <select id="email-campaign-category" className="settings-input" value={category} disabled={busy} onChange={(event) => setCategory(event.target.value as EmailCampaignCategory)}>
          {CAMPAIGN_CATEGORIES.map((option) => <option key={option} value={option}>{t(`emailCampaign${option[0].toUpperCase()}${option.slice(1)}`)}</option>)}
        </select>
      </div>
      <div className="settings-field">
        <label htmlFor="email-campaign-subject" className="settings-label">{t("emailCampaignSubject")}</label>
        <input id="email-campaign-subject" className="settings-input" maxLength={120} value={subject} disabled={busy} onChange={(event) => setSubject(event.target.value)} />
      </div>
      <div className="settings-field">
        <label htmlFor="email-campaign-body" className="settings-label">{t("emailCampaignBody")}</label>
        <textarea id="email-campaign-body" className="settings-input" rows={8} maxLength={10_000} value={body} disabled={busy} onChange={(event) => setBody(event.target.value)} />
      </div>
      <div className="settings-field">
        <label htmlFor="email-campaign-expiry" className="settings-label">{t("emailCampaignExpiry")}</label>
        <input id="email-campaign-expiry" className="settings-input" type="datetime-local" value={expiresLocal} disabled={busy} onChange={(event) => setExpiresLocal(event.target.value)} />
      </div>
    </>}

    {campaignId && <>
      <p className="settings-hint">{t("emailCampaignId")}: <code>{campaignId}</code></p>
      {preview ? <div>
        {preview.campaign.status === "draft" && <p><strong>{t("emailCampaignDraft")}</strong></p>}
        <p><strong>{preview.campaign.subject}</strong></p>
        <p>{t("emailCampaignEligible", { count: preview.eligible_recipients })}</p>
        <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", padding: 12, border: "1px solid var(--border-color, #555)", borderRadius: 8 }}>
          {preview.campaign.body}
        </pre>
      </div> : <p role="status">{t("emailCampaignLoading")}</p>}
    </>}

    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
      {!campaignId && <button type="button" className="settings-btn" disabled={busy || !subject || !body} onClick={() => void createOrPreview()}>{busy ? t("emailCampaignLoading") : t("emailCampaignCreate")}</button>}
      {campaignId && !preview?.campaign.status && <button type="button" className="settings-btn" disabled={busy} onClick={() => void createOrPreview()}>{busy ? t("emailCampaignLoading") : tCommon("retry")}</button>}
      {campaignId && preview?.campaign.status === "draft" && <>
        <button type="button" className="settings-btn settings-btn-danger" disabled={busy} onClick={() => void publish()}>{busy ? t("emailCampaignLoading") : t("emailCampaignPublish")}</button>
        <button type="button" className="settings-btn settings-btn-secondary" disabled={busy} onClick={() => void createOrPreview()}>{tCommon("retry")}</button>
      </>}
      {hasLocalDraft && <button type="button" className="settings-btn settings-btn-secondary" disabled={busy} onClick={() => void resetDraft()}>{t("emailCampaignReset")}</button>}
      {campaignId && preview?.campaign.status === "published" && <p role="status">{t("emailCampaignPublished")}</p>}
    </div>
  </section>;
}

function toLocalInput(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return defaultExpiryLocal();
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

export default EmailCampaignPanel;
