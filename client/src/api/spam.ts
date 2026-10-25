import { apiClient } from "./client";
export type SpamReference = { source_kind: "channel" | "dm" | "group"; channel_id: string; message_id: string; revision: string };
export type SpamEntry = SpamReference & { reasons: string[]; status: string; created_at: string; unavailable?: boolean; server_id?: string; author_id?: string };
export const listSpam = (cursor = "", signal?: AbortSignal, isCurrent?: () => boolean) => apiClient<{ entries: SpamEntry[]; next_cursor?: string }>(`/users/me/spam?limit=50&cursor=${encodeURIComponent(cursor)}`, { signal, isCurrent });
export const listSpamDecisions = (cursor = "", isCurrent?: () => boolean) => apiClient<{ entries: SpamEntry[]; next_cursor?: string }>(`/users/me/spam/decisions?limit=100&cursor=${encodeURIComponent(cursor)}`, { isCurrent });
export const recordSpam = (body: SpamReference & { reasons: string[] }, signal?: AbortSignal, isCurrent?: () => boolean) => apiClient<void>("/users/me/spam", { method: "POST", body, signal, isCurrent });
export const decideSpam = (entry: SpamReference, decision: "restore" | "dismiss", options?: { signal?: AbortSignal; isCurrent?: () => boolean }) => apiClient<void>(`/users/me/spam/${decision}`, { ...options, method: "POST", body: { source_kind: entry.source_kind, channel_id: entry.channel_id, message_id: entry.message_id, revision: entry.revision } });
