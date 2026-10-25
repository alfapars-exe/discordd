/**
 * Report API — user reporting endpoint.
 *
 * Supports multipart (with evidence files) or JSON body.
 */

import { apiClient } from "./client";

export type ReportReason =
  | "spam"
  | "harassment"
  | "inappropriate_content"
  | "impersonation"
  | "other";

export type CreateReportRequest = {
  reason: ReportReason;
  description: string;
  source_kind?: "channel" | "dm" | "group";
  source_server_id?: string;
  source_channel_id?: string;
  source_message_id?: string;
  evidence_content?: string;
  evidence_consent?: boolean;
};

export type ReportAttachment = {
  id: string;
  report_id: string;
  filename: string;
  file_url: string;
  file_size: number | null;
  mime_type: string | null;
  created_at: string;
};

export type Report = {
  id: string;
  reporter_id: string;
  reported_user_id: string;
  reason: ReportReason;
  description: string;
  status: string;
  created_at: string;
  attachments: ReportAttachment[];
};

/** Reports a user. Uses multipart/form-data when evidence files are provided. */
export function reportUser(userId: string, req: CreateReportRequest, files?: File[]) {
  if (files && files.length > 0) {
    const formData = new FormData();
    formData.append("reason", req.reason);
    formData.append("description", req.description);
    if (req.source_kind) formData.append("source_kind", req.source_kind);
    if (req.source_server_id) formData.append("source_server_id", req.source_server_id);
    if (req.source_channel_id) formData.append("source_channel_id", req.source_channel_id);
    if (req.source_message_id) formData.append("source_message_id", req.source_message_id);
    if (req.evidence_content) formData.append("evidence_content", req.evidence_content);
    formData.append("evidence_consent", String(req.evidence_consent === true));
    for (const file of files) {
      formData.append("files", file);
    }
    return apiClient<Report>(`/users/${userId}/report`, {
      method: "POST",
      body: formData,
    });
  }

  return apiClient<Report>(`/users/${userId}/report`, {
    method: "POST",
    body: req,
  });
}
