import {apiClient} from "./client";

export type UserMediaLabel = "ordinary" | "sexual" | "disturbing" | "both";
export type MediaLabelReference = {source_kind:"channel"|"dm"|"group";channel_id:string;message_id:string;revision:string;fingerprint:string};
export type MediaLabelAnnotation = MediaLabelReference & {label:UserMediaLabel;version:string};
type Options = {isCurrent?:()=>boolean;signal?:AbortSignal};
type MutationOptions = Options & {expectedVersion:string};

// Explicit field selection prevents accidentally forwarding a message/media object.
function referenceBody(reference:MediaLabelReference):MediaLabelReference {
  return {source_kind:reference.source_kind,channel_id:reference.channel_id,message_id:reference.message_id,revision:reference.revision,fingerprint:reference.fingerprint};
}
export function getMediaLabel(reference:MediaLabelReference,options?:Options){
  const query=new URLSearchParams(referenceBody(reference));
  return apiClient<{annotation:MediaLabelAnnotation|null}>(`/users/me/media-label?${query}`,{...options,timeoutMs:15000});
}
export function setMediaLabel(reference:MediaLabelReference,label:UserMediaLabel,options:MutationOptions){
  const {expectedVersion,...request}=options;
  return apiClient<{success:boolean}>("/users/me/media-label",{...request,timeoutMs:15000,method:"PUT",body:{...referenceBody(reference),label,expected_version:expectedVersion}});
}
export function deleteMediaLabel(reference:MediaLabelReference,options:MutationOptions){
  const {expectedVersion,...request}=options;
  return apiClient<{success:boolean}>("/users/me/media-label",{...request,timeoutMs:15000,method:"DELETE",body:{...referenceBody(reference),expected_version:expectedVersion}});
}
