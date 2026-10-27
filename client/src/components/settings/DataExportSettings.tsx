import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { createDataExport, downloadDataExport, downloadDataExportAttachments, getDataExport, type DataExportJob } from "../../api/dataExport";
import { getAuthGeneration } from "../../api/client";
import { subscribeAuthGenerationChanges } from "../../api/authSessionEvents";
import { useAuthStore } from "../../stores/authStore";
import { useToastStore } from "../../stores/toastStore";
import { formatDateTime } from "../../utils/dateFormat";

export default function DataExportSettings({ userID }: { userID: string }) {
  const { t } = useTranslation("settings");
  const toast = useToastStore((s) => s.addToast);
  const authOwnerID = useAuthStore((s) => s.user?.id ?? null);
  const pending = useRef(false);
  const [job, setJob] = useState<DataExportJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [authGeneration, setAuthGeneration] = useState(getAuthGeneration);
  const jobGeneration = useRef<number | null>(null);
  const operationNonce = useRef(0);
  const currentJobID = useRef<string | null>(null);
  const alive = useRef(true);
  const current = () => alive.current && authOwnerID === userID && useAuthStore.getState().user?.id === userID;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    const unsubscribe = subscribeAuthGenerationChanges(() => setAuthGeneration(getAuthGeneration()));
    setAuthGeneration(getAuthGeneration());
    return unsubscribe;
  }, []);
  useEffect(() => {
    if (authOwnerID === userID && (jobGeneration.current === null || jobGeneration.current === authGeneration)) return;
    if (!currentJobID.current) return;
    operationNonce.current++;
    currentJobID.current = null;
    jobGeneration.current = null;
    setJob(null);
    if (authOwnerID === userID) toast("error", t("dataExport.jobUnavailable"));
  }, [authGeneration, authOwnerID, t, toast, userID]);

  useEffect(() => {
    const jobID = job?.id;
    const attachmentStatus = job?.attachments_status;
    if (!jobID || (attachmentStatus !== "pending" && attachmentStatus !== "building")) return;
    const generation = jobGeneration.current;
    const nonce = operationNonce.current;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const requestCurrent = () => !cancelled && alive.current && currentJobID.current === jobID && operationNonce.current === nonce && useAuthStore.getState().user?.id === userID && generation !== null && getAuthGeneration() === generation;
    const invalidate = (message: string) => {
      if (operationNonce.current !== nonce || currentJobID.current !== jobID) return;
      operationNonce.current++;
      currentJobID.current = null;
      jobGeneration.current = null;
      setJob(null);
      toast("error", t(message));
    };
    const poll = async () => {
      if (!requestCurrent()) return;
      try {
        const response = await getDataExport(jobID, requestCurrent);
        if (!alive.current || useAuthStore.getState().user?.id !== userID || currentJobID.current !== jobID || operationNonce.current !== nonce) return;
        if (generation === null || getAuthGeneration() !== generation) {
          invalidate("dataExport.jobUnavailable");
          return;
        }
        if (response.success && response.data) {
          if (response.data.id !== jobID) {
            invalidate("dataExport.jobUnavailable");
            return;
          }
          setJob(response.data);
          if (response.data.attachments_status === "pending" || response.data.attachments_status === "building") {
            timer = setTimeout(() => void poll(), 1500);
          }
        } else if (response.status === 401 || response.status === 403 || response.status === 404) {
          invalidate("dataExport.jobUnavailable");
        } else {
          timer = setTimeout(() => void poll(), 3000);
        }
      } catch {
        if (requestCurrent()) timer = setTimeout(() => void poll(), 3000);
      }
    };
    timer = setTimeout(() => void poll(), 1000);
    return () => { cancelled = true; if (timer !== undefined) clearTimeout(timer); };
  }, [job?.id, job?.attachments_status, userID]);

  async function create() {
    if (pending.current || !current()) return;
    const nonce = ++operationNonce.current;
    currentJobID.current = null;
    jobGeneration.current = null;
    setJob(null);
    pending.current = true; setBusy(true);
    const generation = getAuthGeneration();
    const requestCurrent = () => current() && operationNonce.current === nonce && getAuthGeneration() === generation;
    try {
      const result = await createDataExport(requestCurrent);
      if (!requestCurrent()) return;
      if (!result.success || !result.data || result.data.status !== "ready") {
        toast("error", t("dataExport.error")); return;
      }
      jobGeneration.current = generation;
      currentJobID.current = result.data.id;
      setJob(result.data);
      toast("success", t("dataExport.ready"));
    } catch {
      if (requestCurrent()) toast("error", t("dataExport.error"));
    } finally {
      pending.current = false;
      if (current() && operationNonce.current === nonce) setBusy(false);
    }
  }

  async function download() {
    if (!job || pending.current || !current()) return;
    if (jobGeneration.current !== getAuthGeneration()) {
      setJob(null); toast("error", t("dataExport.downloadError")); return;
    }
    pending.current = true; setBusy(true);
    const generation = getAuthGeneration();
    const requestCurrent = () => current() && getAuthGeneration() === generation;
    try {
      const result = await downloadDataExport(job, requestCurrent);
      if (requestCurrent() && !result.success) toast("error", t("dataExport.downloadError"));
    } catch {
      if (requestCurrent()) toast("error", t("dataExport.downloadError"));
    } finally {
      pending.current = false;
      if (current()) setBusy(false);
    }
  }

  async function downloadAttachments() {
    if (!job || !job.attachments_ready || pending.current || !current()) return;
    if (jobGeneration.current !== getAuthGeneration()) { setJob(null); toast("error", t("dataExport.downloadError")); return; }
    pending.current = true; setBusy(true);
    const generation = getAuthGeneration();
    const requestCurrent = () => current() && getAuthGeneration() === generation;
    try {
      const result = await downloadDataExportAttachments(job, requestCurrent);
      if (requestCurrent() && !result.success) toast("error", t("dataExport.downloadError"));
    } catch { if (requestCurrent()) toast("error", t("dataExport.downloadError")); }
    finally { pending.current = false; if (current()) setBusy(false); }
  }

  const visibleJob = authOwnerID === userID && jobGeneration.current === authGeneration ? job : null;
  return <section className="settings-subsection" data-settings-section="data-export">
    <div className="settings-divider" />
    <h3 className="settings-section-subtitle">{t("dataExport.title")}</h3>
    <p className="settings-hint">{t("dataExport.description")}</p>
    {visibleJob && <p className="settings-hint">{t("dataExport.expires", { date: formatDateTime(visibleJob.expires_at) })}</p>}
    {visibleJob?.attachments_status === "pending" || visibleJob?.attachments_status === "building" ? <p className="settings-hint">{t("dataExport.attachmentsPreparing")}</p> : null}
    {visibleJob?.attachments_status === "failed" || visibleJob?.attachments_status === "not_configured" ? <p className="settings-hint">{t("dataExport.attachmentsUnavailable")}</p> : null}
    <div className="settings-btn-row">
      <button className="settings-btn" disabled={busy} onClick={() => void create()}>{busy && !visibleJob ? t("dataExport.preparing") : t("dataExport.create")}</button>
      {visibleJob?.status === "ready" && <button className="settings-btn" disabled={busy} onClick={() => void download()}>{t("dataExport.download")}</button>}
      {visibleJob?.status === "ready" && visibleJob.attachments_ready && <button className="settings-btn" disabled={busy} onClick={() => void downloadAttachments()}>{t("dataExport.downloadAttachments")}</button>}
    </div>
  </section>;
}
