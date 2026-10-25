import { useTranslation } from "react-i18next";
import type { AdminReportListItem } from "../../types";

export default function AdminReportEvidence({ report }: { report: AdminReportListItem }) {
  const { t } = useTranslation("settings");
  if (!report.source_message_id) return null;
  return <details>
    <summary>{t("platformReportMessageContext")}</summary>
    <dl>
      <dt>{t("platformReportSource")}</dt>
      <dd style={{ overflowWrap: "anywhere" }}>{[report.source_kind, report.source_server_id, report.source_channel_id, report.source_message_id].filter(Boolean).join(" / ")}</dd>
    </dl>
    {report.evidence_shared && report.evidence_content
      ? <><p>{t("platformReportEvidenceProvenance")}</p><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{report.evidence_content}</pre></>
      : <p>{t("platformReportNoSharedText")}</p>}
  </details>;
}
