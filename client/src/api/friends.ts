/**
 * Friends API — friendship system endpoints.
 */

import { apiClient,getAuthGeneration } from "./client";
import type { FriendshipWithUser, FriendRequestsResponse } from "../types";

type FriendRequestContext={expectedUserId?:string;isCurrent?:()=>boolean};
function scope(context:FriendRequestContext){
  const generation=getAuthGeneration();
  return {query:context.expectedUserId?`?expected_user_id=${encodeURIComponent(context.expectedUserId)}`:"",options:{timeoutMs:15000,isCurrent:()=>generation===getAuthGeneration()&&(!context.isCurrent||context.isCurrent())}};
}
export function listFriends(context:FriendRequestContext={}) {
  const request=scope(context);
  return apiClient<FriendshipWithUser[]>(`/friends${request.query}`,request.options);
}

export function listRequests(context:FriendRequestContext={}) {
  const request=scope(context);
  return apiClient<FriendRequestsResponse>(`/friends/requests${request.query}`,request.options);
}

export function sendRequest(username: string,context:FriendRequestContext={}) {
  const request=scope(context);
  return apiClient<FriendshipWithUser>(`/friends/requests${request.query}`, {
    ...request.options,
    method: "POST",
    body: { username },
  });
}

export function acceptRequest(requestId: string,context:FriendRequestContext={}) {
  const request=scope(context);
  return apiClient<FriendshipWithUser>(`/friends/requests/${encodeURIComponent(requestId)}/accept${request.query}`, {
    ...request.options,
    method: "POST",
  });
}

export function declineRequest(requestId: string,context:FriendRequestContext={}) {
  const request=scope(context);
  return apiClient<{ message: string }>(`/friends/requests/${encodeURIComponent(requestId)}${request.query}`, {
    ...request.options,
    method: "DELETE",
  });
}

export function removeFriend(userId: string,context:FriendRequestContext={}) {
  const request=scope(context);
  return apiClient<{ message: string }>(`/friends/${encodeURIComponent(userId)}${request.query}`, {
    ...request.options,
    method: "DELETE",
  });
}
