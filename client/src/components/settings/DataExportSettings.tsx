import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { createDataExport, downloadDataExport, type DataExportJob } from "../../api/dataExport";
import { useAuthStore } from "../../stores/authStore";
import { useToastStore } from "../../stores/toastStore";
import { formatDateTime } from "../../utils/dateFormat";

export default function DataExportSettings({ userID }: { userID: string }) {
  const { t } = useTranslation("settings");
  const toast = useToastStore((s) => s.addToast);
  const pending = useRef(false);
  const [job, setJob] = useState<DataExportJob | null>(null);
  const [busy, setBusy] = useState(false);
  const current = () => useAuthStore.getState().user?.id === userID;

  async function create() {
    if (pending.current) return;
    pending.current = true; setBusy(true);
    const result = await createDataExport(current);
    pending.current = false;
    if (!current()) return;
    setBusy(false);
    if (!result.success || !result.data) { toast("error", t("dataExport.error")); return; }
    setJob(result.data);
    toast("success", t("dataExport.ready"));
  }

  async function download() {
    if (!job || pending.current) return;
    pending.current = true; setBusy(true);
    const result = await downloadDataExport(job);
    pending.current = false;
    if (!current()) return;
    setBusy(false);
    if (!result.success) toast("error", t("dataExport.downloadError"));
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
