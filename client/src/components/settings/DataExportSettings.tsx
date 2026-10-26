import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { createDataExport, downloadDataExport, type DataExportJob } from "../../api/dataExport";
import { getAuthGeneration } from "../../api/client";
import { useAuthStore } from "../../stores/authStore";
import { useToastStore } from "../../stores/toastStore";
import { formatDateTime } from "../../utils/dateFormat";

export default function DataExportSettings({ userID }: { userID: string }) {
  const { t } = useTranslation("settings");
  const toast = useToastStore((s) => s.addToast);
  const pending = useRef(false);
  const [job, setJob] = useState<DataExportJob | null>(null);
  const [busy, setBusy] = useState(false);
  const jobGeneration = useRef<number | null>(null);
  const alive = useRef(true);
  const current = () => alive.current && useAuthStore.getState().user?.id === userID;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  async function create() {
    if (pending.current || !current()) return;
    pending.current = true; setBusy(true);
    const generation = getAuthGeneration();
    const requestCurrent = () => current() && getAuthGeneration() === generation;
    try {
      const result = await createDataExport(requestCurrent);
      if (!requestCurrent()) return;
      if (!result.success || !result.data || result.data.status !== "ready") {
        toast("error", t("dataExport.error")); return;
      }
      jobGeneration.current = generation;
      setJob(result.data);
      toast("success", t("dataExport.ready"));
    } catch {
      if (requestCurrent()) toast("error", t("dataExport.error"));
    } finally {
      pending.current = false;
      if (current()) setBusy(false);
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

  return <section className="settings-subsection" data-settings-section="data-export">
    <div className="settings-divider" />
    <h3 className="settings-section-subtitle">{t("dataExport.title")}</h3>
    <p className="settings-hint">{t("dataExport.description")}</p>
    {job && <p className="settings-hint">{t("dataExport.expires", { date: formatDateTime(job.expires_at) })}</p>}
    <div className="settings-btn-row">
      <button className="settings-btn" disabled={busy} onClick={() => void create()}>{busy && !job ? t("dataExport.preparing") : t("dataExport.create")}</button>
      {job?.status === "ready" && <button className="settings-btn" disabled={busy} onClick={() => void download()}>{t("dataExport.download")}</button>}
    </div>
  </section>;
}
