import { apiClient, getAuthGeneration } from "./client";
import type { Channel } from "../types";

export type ThreadRequestContext = { expectedUserId?: string; isCurrent?: () => boolean };

function requestScope(context: ThreadRequestContext = {}) {
  const generation = getAuthGeneration();
  const query = context.expectedUserId ? `&expected_user_id=${encodeURIComponent(context.expectedUserId)}` : "";
  return {
    query,
    options: {
      timeoutMs: 15000,
      isCurrent: () => generation === getAuthGeneration() && (!context.isCurrent || context.isCurrent()),
    },
  };
}

export function listThreads(serverID: string, channelID: string, includeArchived = true, context: ThreadRequestContext = {}) {
  const scope = requestScope(context);
  return apiClient<{ threads: Channel[] }>(`/servers/${encodeURIComponent(serverID)}/channels/${encodeURIComponent(channelID)}/threads?archived=${includeArchived}${scope.query}`, scope.options);
}
export function getThread(serverID: string, threadID: string, context: ThreadRequestContext = {}) {
  const scope = requestScope(context);
  return apiClient<Channel>(`/servers/${encodeURIComponent(serverID)}/threads/${encodeURIComponent(threadID)}${scope.query ? `?${scope.query.slice(1)}` : ""}`, scope.options);
}
export function createThread(serverID: string, channelID: string, messageID: string, name: string, context: ThreadRequestContext = {}) {
  const scope = requestScope(context);
  return apiClient<Channel>(`/servers/${encodeURIComponent(serverID)}/channels/${encodeURIComponent(channelID)}/threads${scope.query ? `?${scope.query.slice(1)}` : ""}`, { ...scope.options, method: "POST", body: { message_id: messageID, name } });
}
export function setThreadArchived(serverID: string, threadID: string, archived: boolean, context: ThreadRequestContext = {}) {
  const scope = requestScope(context);
  return apiClient<Channel>(`/servers/${encodeURIComponent(serverID)}/threads/${encodeURIComponent(threadID)}${scope.query ? `?${scope.query.slice(1)}` : ""}`, { ...scope.options, method: "PATCH", body: { archived } });
}
