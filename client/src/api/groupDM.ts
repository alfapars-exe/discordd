import { apiClient,getAuthGeneration } from "./client";
import type { GroupDM, GroupDMMessage, GroupDMReadState,GroupDMMessagesAroundPage,GroupSendResponse,GroupSendOutcome } from "../types/groupDM";
import type { VoiceTokenResponse } from "../types/voice";
export type GroupDMRequestScope = {isCurrent?:()=>boolean;signal?:AbortSignal;timeoutMs?:number};
export type GroupDMMembershipRequestScope = {expectedUserId?:string;isCurrent?:()=>boolean};

function membershipScope(context:GroupDMMembershipRequestScope={}){
  const generation=getAuthGeneration();
  return {
    query:context.expectedUserId?`?expected_user_id=${encodeURIComponent(context.expectedUserId)}`:"",
    options:{timeoutMs:15_000,isCurrent:()=>generation===getAuthGeneration()&&(!context.isCurrent||context.isCurrent())},
  };
}

export const listGroupDMs = (scope?:GroupDMRequestScope) => apiClient<{ group_dms: GroupDM[] }>("/group-dms",scope);
export const createGroupDM = (name: string, userIds: string[],scope?:GroupDMRequestScope) => apiClient<GroupDM>("/group-dms", { method: "POST", body: { name, user_ids: userIds },...scope });
export const updateGroupDM = (groupId: string, name: string, iconUrl: string | null) => apiClient<GroupDM>(`/group-dms/${groupId}`, { method: "PATCH", body: { name, icon_url: iconUrl } });
export const addGroupDMMember = (groupId: string, userId: string, context:GroupDMMembershipRequestScope={}) => {const request=membershipScope(context);return apiClient<GroupDM>(`/group-dms/${encodeURIComponent(groupId)}/members${request.query}`, { ...request.options,method: "POST", body: { user_id: userId } });};
export const removeGroupDMMember = (groupId: string, userId: string, context:GroupDMMembershipRequestScope={}) => {const request=membershipScope(context);return apiClient<GroupDM>(`/group-dms/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}${request.query}`, { ...request.options,method: "DELETE" });};
export const leaveGroupDM = (groupId: string, context:GroupDMMembershipRequestScope={}) => {const request=membershipScope(context);return apiClient<void>(`/group-dms/${encodeURIComponent(groupId)}/leave${request.query}`, { ...request.options,method: "POST" });};
export const listGroupDMMessages = (groupId: string, before?: string, limit = 50,scope?:GroupDMRequestScope) => {
  const params = new URLSearchParams({ limit: String(limit) });
  if (before) params.set("before", before);
  const query = `?${params}`;
  return apiClient<{ messages: GroupDMMessage[] }>(`/group-dms/${groupId}/messages${query}`,scope);
};
export const getGroupDMMessagesAround = (groupId: string, messageId: string, limit = 50, scope?: GroupDMRequestScope) => {
  const params = new URLSearchParams({ around: messageId, limit: String(limit) });
  return apiClient<GroupDMMessagesAroundPage>(`/group-dms/${encodeURIComponent(groupId)}/messages?${params}`, scope);
};
export type GroupSendPayload={ciphertext:string;sender_device_id:string;e2ee_metadata:string;key_epoch:number;reply_to_id?:string;client_request_id?:string};
export const getGroupSendOutcome=(groupId:string,id:string,scope?:GroupDMRequestScope)=>apiClient<GroupSendOutcome>(`/group-dms/${groupId}/send-operations/${encodeURIComponent(id)}`,scope);
export const cancelGroupSend=(groupId:string,id:string,scope?:GroupDMRequestScope)=>apiClient<GroupSendOutcome>(`/group-dms/${groupId}/send-operations/${encodeURIComponent(id)}/cancel`,{method:"POST",...scope});
export const reconcileGroupSend=(groupId:string,id:string,scope?:GroupDMRequestScope)=>apiClient<GroupSendResponse>(`/group-dms/${groupId}/send-operations/${encodeURIComponent(id)}/reconcile`,{method:"POST",...scope});
export const sendGroupDMMessage = (groupId: string, payload: GroupSendPayload,files?:File[],scope?:GroupDMRequestScope) => {
  if(files?.length){const body=new FormData();body.append("ciphertext",payload.ciphertext);body.append("sender_device_id",payload.sender_device_id);body.append("e2ee_metadata",payload.e2ee_metadata);body.append("key_epoch",String(payload.key_epoch));if(payload.client_request_id)body.append("client_request_id",payload.client_request_id);if(payload.reply_to_id)body.append("reply_to_id",payload.reply_to_id);for(const file of files)body.append("files",file);return apiClient<GroupSendResponse>(`/group-dms/${groupId}/messages`,{method:"POST",body,...scope});}
  return apiClient<GroupSendResponse>(`/group-dms/${groupId}/messages`, { method: "POST", body: payload,...scope });
};
export const editGroupDMMessage = (groupId: string, messageId: string, payload: { ciphertext: string; sender_device_id: string; e2ee_metadata: string; key_epoch: number },scope?:GroupDMRequestScope) => apiClient<GroupDMMessage>(`/group-dms/${groupId}/messages/${messageId}`, { method: "PATCH", body: payload,...scope });
export const deleteGroupDMMessage = (groupId: string, messageId: string) => apiClient<void>(`/group-dms/${groupId}/messages/${messageId}`, { method: "DELETE" });
export const toggleGroupDMReaction = (groupId: string, messageId: string, emoji: string) => apiClient<{ status: string }>(`/group-dms/${groupId}/messages/${messageId}/reactions`, { method: "POST", body: { emoji } });
export const markGroupDMRead = (groupId: string, messageId?: string, options?: {isCurrent?:()=>boolean}) => apiClient<GroupDMReadState>(`/group-dms/${groupId}/read`, { method: "POST", body: { message_id: messageId ?? null },timeoutMs:15_000,...options });
export const markGroupDMUnread = (groupId: string, messageId: string, options?: {isCurrent?:()=>boolean}) => apiClient<GroupDMReadState>(`/group-dms/${groupId}/unread`, { method: "POST", body: { message_id: messageId },timeoutMs:15_000,...options });
export const getGroupDMCallToken = (groupId: string) => apiClient<VoiceTokenResponse>(`/group-dms/${groupId}/call-token`, { method: "POST" });

export type GroupDMPinRequestScope = GroupDMMembershipRequestScope & { signal?: AbortSignal };
export const listPinnedGroupDMMessages = (groupId: string, context: GroupDMPinRequestScope = {}) => {
  const request = membershipScope(context);
  return apiClient<{ messages: GroupDMMessage[] }>(`/group-dms/${encodeURIComponent(groupId)}/pinned${request.query}`, { ...request.options, signal: context.signal });
};
export const pinGroupDMMessage = (groupId: string, messageId: string, context: GroupDMPinRequestScope = {}) => {
  const request = membershipScope(context);
  return apiClient<{ status: "pinned" }>(`/group-dms/${encodeURIComponent(groupId)}/messages/${encodeURIComponent(messageId)}/pin${request.query}`, { ...request.options, method: "POST", signal: context.signal });
};
export const unpinGroupDMMessage = (groupId: string, messageId: string, context: GroupDMPinRequestScope = {}) => {
  const request = membershipScope(context);
  return apiClient<{ status: "unpinned" }>(`/group-dms/${encodeURIComponent(groupId)}/messages/${encodeURIComponent(messageId)}/pin${request.query}`, { ...request.options, method: "DELETE", signal: context.signal });
};
