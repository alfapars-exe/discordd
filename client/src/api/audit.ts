/**
 * audit — REST client for audit channel content.
 *
 * The server endpoint enforces permission (Admin or any of
 * Kick/Ban/Mute/Deafen members) and returns 403 to unauthorized users;
 * we surface the toast in the caller. Pagination uses a keyset cursor:
 * `beforeId` (the id of the last row we hold) is preferred — the server
 * resolves its created_at internally and pages on (created_at, id) so no
 * page boundary drops rows that share a second. `before` (RFC3339) is sent
 * alongside it only for backward compatibility with older servers.
 */

import { apiClient } from "./client";
import type { AuditLog } from "../types";

type ListResponse = {
  entries: AuditLog[];
};

export async function listServerAudit(
  serverId: string,
  options: { limit?: number; before?: string; beforeId?: string } = {},
) {
  const params = new URLSearchParams();
  if (options.limit !== undefined) {
    params.set("limit", String(options.limit));
  }
  if (options.before) {
    params.set("before", options.before);
  }
  if (options.beforeId) {
    params.set("before_id", options.beforeId);
  }
  const qs = params.toString();
  const url = qs
    ? `/servers/${serverId}/audit?${qs}`
    : `/servers/${serverId}/audit`;
  return apiClient<ListResponse>(url);
}
