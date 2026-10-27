import { apiClient, apiDownload } from "./client";

export type DataExportJob = { id: string; status: "ready" | "failed"; error_code?: string; created_at: string; expires_at: string; attachments_ready?: boolean; attachments_status?: "none" | "not_configured" | "pending" | "building" | "ready" | "failed"; attachments_error?: string };

export function createDataExport(isCurrent?: () => boolean) {
  return apiClient<DataExportJob>("/users/me/data-exports", { method: "POST", timeoutMs: 30000, isCurrent });
}

export function getDataExport(jobID: string, isCurrent?: () => boolean) {
  return apiClient<DataExportJob>(`/users/me/data-exports/${encodeURIComponent(jobID)}`, { isCurrent });
}

export function downloadDataExport(job: DataExportJob, isCurrent?: () => boolean) {
  return apiDownload(`/users/me/data-exports/${encodeURIComponent(job.id)}/download`, `hichat-personal-data-${job.id.slice(0, 12)}.json`, isCurrent);
}

export function downloadDataExportAttachments(job: DataExportJob, isCurrent?: () => boolean) {
  return apiDownload(`/users/me/data-exports/${encodeURIComponent(job.id)}/attachments`, `hichat-personal-data-${job.id.slice(0, 12)}-attachments.zip`, isCurrent);
}
