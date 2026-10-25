import { create } from "zustand";
import { getAuthSessionSnapshot, subscribeAuthGenerationChanges, subscribeAuthOwnerChanges } from "../api/authSessionEvents";
import { getGroupDMCallToken, listGroupDMs } from "../api/groupDM";
import { useGroupDMStore } from "./groupDMStore";
import { useE2EEStore } from "./e2eeStore";
import { useVoiceStore } from "./voiceStore";
import { useGroupCallAudioControlStore } from "./groupCallAudioControlStore";
import { retirePrivateCaptureFailure } from "./microphoneCaptureViewStore";
import type { VoiceTokenResponse } from "../types/voice";
import type { GroupDM } from "../types/groupDM";

export type GroupCallSession = { nonce:string; ownerId:string; generation:number; deviceId:string; groupId:string; label:string;
 keyEpoch:number; manualMuted:boolean; phase:"requesting"|"ready"|"error"; credentials:VoiceTokenResponse|null };
type State={session:GroupCallSession|null;join:(groupId:string)=>boolean;leave:(nonce:string)=>void;retry:(nonce:string)=>boolean};
let revision=0;
let pending:AbortController|null=null;

function ownerCurrent(session:GroupCallSession){
 const auth=getAuthSessionSnapshot(),crypto=useE2EEStore.getState();
 return auth.ownerId===session.ownerId&&auth.generation===session.generation&&crypto.initStatus==="ready"&&crypto.localDeviceId===session.deviceId;
}
function membership(session:GroupCallSession):GroupDM|undefined{
 const state=useGroupDMStore.getState();
 if(state.ownerId!==session.ownerId||state.authGeneration!==session.generation||!state.groupsReady)return;
 return state.groups.find(g=>g.id===session.groupId&&Array.isArray(g.members)&&g.members.some(m=>m?.id===session.ownerId));
}
export function isCurrentGroupCall(nonce:string):boolean{
 const session=useGroupCallStore.getState().session;
 return !!session&&session.nonce===nonce&&ownerCurrent(session)&&!!membership(session);
}
function credentialsMatch(response:VoiceTokenResponse,session:GroupCallSession){
 return response.channel_id===session.groupId&&typeof response.token==="string"&&!!response.token&&typeof response.url==="string"&&!!response.url
 &&typeof response.e2ee_passphrase==="string"&&!!response.e2ee_passphrase&&typeof response.e2ee_key_context==="string"&&!!response.e2ee_key_context
 &&response.e2ee_key_epoch===session.keyEpoch&&Number.isSafeInteger(response.e2ee_key_epoch)
 &&Number.isInteger(response.e2ee_key_index)&&response.e2ee_key_index===session.keyEpoch%256;
}
function requestCredentials(nonce:string){
 const initial=useGroupCallStore.getState().session;if(!initial||initial.nonce!==nonce||!isCurrentGroupCall(nonce))return;
 pending?.abort();const controller=new AbortController();pending=controller;const request=++revision;
 useGroupCallStore.setState({session:{...initial,phase:"requesting"}});
 const current=()=>request===revision&&!controller.signal.aborted&&isCurrentGroupCall(nonce);
 void(async()=>{
  const response=await listGroupDMs({timeoutMs:15_000,signal:controller.signal,isCurrent:current});
  if(!current())return;
  if(!response.success||!response.data){fail();return}
  const actual=response.data.group_dms.find(g=>g.id===initial.groupId&&Array.isArray(g.members)&&g.members.some(m=>m?.id===initial.ownerId));
  if(!actual){useGroupDMStore.getState().handleDelete(initial.groupId);useGroupCallStore.getState().leave(nonce);return}
  if(!Number.isSafeInteger(actual.key_epoch)||actual.key_epoch<=0||actual.key_epoch<initial.keyEpoch){fail();return}
  const latest=useGroupCallStore.getState().session!;
  // Install the refreshed epoch before projecting its metadata. The group
  // subscription must not mistake our own authoritative refresh for a new request.
  useGroupCallStore.setState({session:{...latest,keyEpoch:actual.key_epoch,label:actual.name}});
  useGroupDMStore.getState().handleCreateOrUpdate(actual);
  if(!current())return;
  const epoch=actual.key_epoch;
  const token=await getGroupDMCallToken(initial.groupId,{timeoutMs:15_000,signal:controller.signal,isCurrent:()=>current()&&membership(useGroupCallStore.getState().session!)?.key_epoch===epoch});
  if(!current())return;
  const active=useGroupCallStore.getState().session!;
  if(membership(active)?.key_epoch!==epoch||!token.success||!token.data||!credentialsMatch(token.data,active)){fail();return}
  useGroupCallStore.setState({session:{...active,phase:"ready",credentials:token.data}});
 })().catch(()=>{if(current())fail()}).finally(()=>{if(pending===controller)pending=null});
 function fail(){if(!current())return;const active=useGroupCallStore.getState().session!;useGroupCallStore.setState({session:{...active,phase:"error"}})}
}

/** In-memory explicit call intent only. No credentials or automatic joins are persisted. */
export const useGroupCallStore=create<State>((set,get)=>({
 session:null,
 join:(groupId)=>{
  if(get().session)return false; // Never silently replace another group call.
  const auth=getAuthSessionSnapshot(),crypto=useE2EEStore.getState();if(!auth.ownerId||crypto.initStatus!=="ready"||!crypto.localDeviceId)return false;
  const session:GroupCallSession={nonce:globalThis.crypto.randomUUID(),ownerId:auth.ownerId,generation:auth.generation,deviceId:crypto.localDeviceId,groupId,label:"",keyEpoch:0,manualMuted:useVoiceStore.getState().isMuted,phase:"requesting",credentials:null};
  const group=membership(session);if(!group||!Number.isSafeInteger(group.key_epoch)||group.key_epoch<=0)return false;
  session.label=group.name;session.keyEpoch=group.key_epoch;set({session});requestCredentials(session.nonce);return true;
 },
 leave:(nonce)=>{if(get().session?.nonce!==nonce)return;retirePrivateCaptureFailure(nonce);revision++;pending?.abort();pending=null;set({session:null})},
 retry:(nonce)=>{if(get().session?.nonce!==nonce||!isCurrentGroupCall(nonce)||get().session?.phase!=="error")return false;requestCredentials(nonce);return true},
}));
const retire=()=>{const session=useGroupCallStore.getState().session;if(session&&!ownerCurrent(session))useGroupCallStore.getState().leave(session.nonce)};
subscribeAuthOwnerChanges(retire);subscribeAuthGenerationChanges(retire);useE2EEStore.subscribe(retire);
useGroupDMStore.subscribe(()=>{
 const session=useGroupCallStore.getState().session;if(!session)return;
 const group=membership(session);
 if(!ownerCurrent(session)||!group){useGroupCallStore.getState().leave(session.nonce);return}
 if(group.key_epoch!==session.keyEpoch){
  if(!Number.isSafeInteger(group.key_epoch)||group.key_epoch<session.keyEpoch){useGroupCallStore.getState().leave(session.nonce);return}
  useGroupCallStore.setState({session:{...session,keyEpoch:group.key_epoch,phase:"requesting"}});
  requestCredentials(session.nonce);
 } else if(group.name!==session.label)useGroupCallStore.setState({session:{...session,label:group.name}});
});

// Control identity remains fresh per mounted runtime. Session association is
// metadata only, never a reusable control capability. Preserve intent on clear.
useGroupCallAudioControlStore.subscribe(({control})=>{
 const session=useGroupCallStore.getState().session;
 if(!session||!control||control.callSessionNonce!==session.nonce||control.accountId!==session.ownerId||control.generation!==session.generation||!ownerCurrent(session))return;
 if(session.manualMuted!==control.manualMuted)useGroupCallStore.setState({session:{...session,manualMuted:control.manualMuted}});
});
