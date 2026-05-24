/**
 * Member API — server-scoped member management.
 *
 * Includes role assignment, kick, ban/unban, and profile update.
 */

import { apiClient } from "./client";
import type { MemberWithRoles, Ban } from "../types";

export async function getMembers(serverId: string) {
  return apiClient<MemberWithRoles[]>(`/servers/${serverId}/members`);
}

export async function getMember(serverId: string, id: string) {
  return apiClient<MemberWithRoles>(`/servers/${serverId}/members/${id}`);
}

export async function modifyMemberRoles(
  serverId: string,
  targetId: string,
  roleIds: string[]
) {
  return apiClient<MemberWithRoles>(`/servers/${serverId}/members/${targetId}/roles`, {
    method: "PATCH",
    body: { role_ids: roleIds },
  });
}

export async function kickMember(serverId: string, targetId: string) {
  return apiClient<{ message: string }>(`/servers/${serverId}/members/${targetId}`, {
    method: "DELETE",
  });
}

/**
 * Ban a member. `durationSeconds` turns the permanent ban into a temp
 * ban that auto-lifts at expiry (server enforces this via a WHERE
 * filter; no cleanup job). Omit / pass undefined for a permanent ban.
 */
export async function banMember(
  serverId: string,
  targetId: string,
  reason: string,
  durationSeconds?: number,
) {
  const body: { reason: string; duration_seconds?: number } = { reason };
  if (durationSeconds !== undefined) {
    body.duration_seconds = durationSeconds;
  }
  return apiClient<{ message: string }>(`/servers/${serverId}/members/${targetId}/ban`, {
    method: "POST",
    body,
  });
}

export async function getBans(serverId: string) {
  return apiClient<Ban[]>(`/servers/${serverId}/bans`);
}

export async function unbanMember(serverId: string, userId: string) {
  return apiClient<{ message: string }>(`/servers/${serverId}/bans/${userId}`, {
    method: "DELETE",
  });
}

/**
 * Apply a Discord-style timeout. The user stays in the server but
 * server-side gates block Send-Message and voice joins until expiry.
 * Reapplying extends an existing timeout (server does an upsert).
 */
export async function timeoutMember(
  serverId: string,
  targetId: string,
  durationSeconds: number,
  reason: string,
) {
  return apiClient<{ message: string }>(
    `/servers/${serverId}/members/${targetId}/timeout`,
    {
      method: "PUT",
      body: { duration_seconds: durationSeconds, reason },
    },
  );
}

/** Lift an active timeout. Idempotent — no error if user wasn't muted. */
export async function removeTimeout(serverId: string, targetId: string) {
  return apiClient<{ message: string }>(
    `/servers/${serverId}/members/${targetId}/timeout`,
    { method: "DELETE" },
  );
}

/**
 * Set or clear a per-server nickname. Self-rename always allowed;
 * renaming someone else requires PermManageNicknames (server enforces).
 * Pass an empty string to clear the nickname.
 */
export async function setMemberNickname(
  serverId: string,
  targetId: string,
  nickname: string,
) {
  return apiClient<MemberWithRoles>(
    `/servers/${serverId}/members/${targetId}/nickname`,
    {
      method: "PATCH",
      body: { nickname },
    },
  );
}

/** Updates own profile (global, not server-scoped). */
export async function updateProfile(data: {
  display_name?: string;
  avatar_url?: string;
  custom_status?: string;
}) {
  return apiClient<MemberWithRoles>("/users/me/profile", {
    method: "PATCH",
    body: data,
  });
}
