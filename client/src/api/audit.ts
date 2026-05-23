/**
 * audit — REST client for audit channel content.
 *
 * The server endpoint enforces permission (Admin or any of
 * Kick/Ban/Mute/Deafen members) and returns 403 to unauthorized users;
 * we surface the toast in the caller. Pagination uses an RFC3339
 * `before` cursor matching the server's audit_logs.created_at column.
 */

import { apiClient } from "./client";
import type { AuditLog } from "../types";

type ListResponse = {
  entries: AuditLog[];
};

export async function listServerAudit(
  serverId: string,
  options: { limit?: number; before?: string } = {},
) {
  const params = new URLSearchParams();
  if (options.limit !== undefined) {
    params.set("limit", String(options.limit));
  }
  if (options.before) {
    params.set("before", options.before);
  }
  const qs = params.toString();
  const url = qs
    ? `/servers/${serverId}/audit?${qs}`
    : `/servers/${serverId}/audit`;
  return apiClient<ListResponse>(url);
}
