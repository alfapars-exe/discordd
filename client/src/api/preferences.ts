/**
 * Preferences API — server-side user preferences (theme, sidebar, voice settings).
 */

import { apiClient } from "./client";

export type UserPreferencesResponse = {
  schema_version?: number;
  user_id: string;
  data: Record<string, unknown>;
  updated_at: string;
};

/** Fetch all user preferences. Returns empty {} if none saved yet. */
type PreferenceRequestContext = { expectedUserId?: string; isCurrent?: () => boolean; signal?: AbortSignal };

export async function getPreferences({ expectedUserId, isCurrent, signal }: PreferenceRequestContext = {}) {
  const query = expectedUserId ? `?expected_user_id=${encodeURIComponent(expectedUserId)}` : "";
  return apiClient<UserPreferencesResponse>(`/users/me/preferences${query}`, {
    method: "GET",
    isCurrent,
    signal,
    timeoutMs: 15_000,
  });
}

/** Merge partial preferences; known object namespaces merge individual leaves. */
export async function updatePreferences(data: Record<string, unknown>, { expectedUserId, isCurrent, signal }: PreferenceRequestContext = {}) {
  return apiClient<UserPreferencesResponse>("/users/me/preferences", {
    method: "PATCH",
    // A different tab can replace the shared refresh cookie. Bind the write to
    // its original account on the server, before it can mutate any preference.
    body: { data, ...(expectedUserId ? { expected_user_id: expectedUserId } : {}) },
    isCurrent,
    signal,
    timeoutMs: 15_000,
  });
}
