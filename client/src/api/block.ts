/**
 * Block API — user blocking endpoints.
 */

import { apiClient,getAuthGeneration } from "./client";
import type { FriendshipWithUser } from "../types";

type BlockRequestContext={expectedUserId?:string;isCurrent?:()=>boolean};
function requestScope(context:BlockRequestContext){
  const generation=getAuthGeneration();
  return {query:context.expectedUserId?`?expected_user_id=${encodeURIComponent(context.expectedUserId)}`:"",isCurrent:()=>generation===getAuthGeneration()&&(!context.isCurrent||context.isCurrent())};
}
export function blockUser(userId: string,context:BlockRequestContext={}) {
  const scope=requestScope(context);
  return apiClient<void>(`/users/${encodeURIComponent(userId)}/block${scope.query}`, { method: "POST",isCurrent:scope.isCurrent,timeoutMs:15000 });
}

export function unblockUser(userId: string,context:BlockRequestContext={}) {
  const scope=requestScope(context);
  return apiClient<void>(`/users/${encodeURIComponent(userId)}/block${scope.query}`, { method: "DELETE",isCurrent:scope.isCurrent,timeoutMs:15000 });
}

export function listBlocked(context:BlockRequestContext={}) {
  const scope=requestScope(context);
  return apiClient<FriendshipWithUser[]>(`/users/blocked${scope.query}`,{isCurrent:scope.isCurrent,timeoutMs:15000});
}
