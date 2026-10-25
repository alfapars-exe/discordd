import {dmSourceSequence,sortDMBySource} from "../utils/dmSourceOrder";
import { create } from "zustand";
import * as api from "../api/groupDM";
import { getAuthGeneration } from "../api/client";
import { getAuthSessionSnapshot, subscribeAuthGenerationChanges, subscribeAuthOwnerChanges } from "../api/authSessionEvents";
import { cacheGroupMessage } from "../crypto/groupMessageCache";
import { decryptGroupDMMessages, encryptGroupDMMessage } from "../crypto/dmEncryption";
import { encodePayload } from "../crypto/e2eePayload";
import type { GroupDM, GroupDMMessage, GroupDMReadState } from "../types/groupDM";
import { useAuthStore } from "./authStore";
import { registerSpamBatch, registerSpamMessage } from "../utils/registerSpamMessage";
import { useE2EEStore } from "./e2eeStore";
import { encryptFilesForE2EE } from "./shared/messageUtils";
import { composerKey,EMPTY_DRAFT,useComposerDraftStore } from "./composerDraftStore";
import { groupAttachmentKeyIndex } from "../utils/groupAttachmentKeys";
import { groupOutcomeResponse,retryGroupSend } from "./shared/groupSendAttempt";
import {savePendingGroupSend,removePendingGroupSend,markPendingGroupSendConfirmed,acknowledgePendingGroupFileChain,type GroupFileSource} from "../crypto/pendingGroupSendStorage";
import {loadGroupSendRestorePlan} from "./shared/groupSendRestoreQueue";

type DurableSendScope={accountId:string;deviceId:string;groupId:string;id:string};
export type GroupUploadRecovery={id:string;messageId:string;files:File[];replyToId?:string;retrying:boolean;retryable:boolean;cancelled?:boolean;durable?:DurableSendScope;sourceIndices?:number[]};
export type GroupPendingSend={id:string;busy:boolean;content:string;files?:File[];replyToId?:string;payload:api.GroupSendPayload;encrypted?:Awaited<ReturnType<typeof encryptFilesForE2EE>>;current:()=>boolean;ownerCurrent?:()=>boolean;started:number;draftRevision:number;originRecoveryId?:string;originDurable?:DurableSendScope;durable?:DurableSendScope;stored?:boolean;createdAt?:number;restored?:boolean;lookupOnly?:boolean;resultConfirmed?:boolean;acknowledgedIndices?:number[];fileSources?:GroupFileSource[]};

type GroupDMState = {
  /** Provenance for all cached groups/messages and pending send context. */
  ownerId: string | null;
  authGeneration: number;
  groups: GroupDM[];
  messages: Record<string, GroupDMMessage[]>;
  hasMoreAfterByGroup: Record<string, boolean>;
  scrollTarget: { groupId: string; messageId: string; request: number; accountId: string; authGeneration: number } | null;
  loading: boolean;
  error: string | null;
  uploadRecoveries:Record<string,GroupUploadRecovery[]>;
  pendingSends:Record<string,GroupPendingSend|undefined>;
  groupsReady:boolean;
  restoreStatus:"idle"|"loading"|"ready"|"error";
  restoreScope:string|null;
  restoreDeviceId:string|null;
  restoreBlocked:string[];
  restoredQueue:Record<string,GroupPendingSend[]>;
  restorePendingSends:(force?:boolean)=>Promise<void>;
  advancePendingSend:(groupId:string)=>void;
  prefillPendingDraft:(groupId:string)=>void;
  retryPendingSend:(groupId:string)=>Promise<boolean>;
  cancelPendingSend:(groupId:string)=>Promise<boolean>;
  retryUploadRecovery:(groupId:string,id:string)=>Promise<boolean>;
  restoreUploadRecovery:(groupId:string,id:string)=>boolean;
  dismissUploadRecovery:(groupId:string,id:string,preserveDurable?:boolean)=>void;
  fetchGroups: () => Promise<void>;
  create: (name: string, userIds: string[]) => Promise<GroupDM | null>;
  fetchMessages: (groupId: string, options?: { jumpToPresent?: boolean }) => Promise<boolean>;
  fetchMessagesAround: (groupId: string, messageId: string, options?: { isCurrent?: () => boolean; timeoutMs?: number }) => Promise<boolean>;
  jumpToPresent: (groupId: string) => void;
  setScrollTarget: (groupId: string, messageId: string) => number | null;
  clearScrollTarget: (request: number) => void;
  searchMessages: (groupId: string, query: string) => Promise<GroupDMMessage[]>;
  send: (groupId: string, content: string, replyToId?: string, files?: File[], context?: GroupDMSendContext) => Promise<boolean>;
  edit: (groupId: string, messageId: string, content: string) => Promise<boolean>;
  removeMessage: (groupId: string, messageId: string) => Promise<boolean>;
  toggleReaction: (groupId: string, messageId: string, emoji: string) => Promise<boolean>;
  markRead: (groupId: string, messageId?: string) => Promise<void>;
  markUnread: (groupId:string,messageId:string)=>Promise<boolean>;
  setMuted:(groupId:string,muted:boolean)=>Promise<boolean>;
  handleReadState: (state:GroupDMReadState)=>void;
  leave: (groupId: string) => Promise<boolean>;
  addMember: (groupId: string, userId: string) => Promise<boolean>;
  removeMember: (groupId: string, userId: string) => Promise<boolean>;
  handleCreateOrUpdate: (group: GroupDM) => void;
  handleDelete: (groupId: string) => void;
  handleMessage: (message: GroupDMMessage) => Promise<GroupMessageAcceptance>;
  handleMessageUpdate: (message: GroupDMMessage) => Promise<void>;
  handleMessageDelete: (groupId: string, messageId: string) => void;
  handleReactionUpdate: (groupId: string, messageId: string, reactions: GroupDMMessage["reactions"]) => void;
};

export type GroupMessageAcceptance = {status:"rejected"} | {
  status:"accepted"; ownerId:string; authGeneration:number; groupId:string; messageId:string;
  keyEpoch:number; deviceId:string; lifetime:number|undefined; sourceVersion:number;
  storage:"visible"|"detached"; message:GroupDMMessage; previewReady:boolean; isCurrent:()=>boolean;
};

/** Optional caller snapshot prevents callbacks retained by an old render from sending in a new session. */
export type GroupDMSendContext = { ownerId: string; authGeneration: number; isCurrent?: () => boolean };

const readRequests = new Map<string,number>();
let accountEpoch=0;
let listRequest=0;
let groupProjectionClock=0;
const groupProjectionVersions=new Map<string,number>();
let messageClock=0;
let recoveryCounter=0;
let scrollTargetRequest=0;
const groupLifetimes=new Map<string,number>();
const historyRequests=new Map<string,number>();
const messageVersions=new Map<string,Map<string,number>>();
const messageCreateVersions=new Map<string,Map<string,number>>();
const aroundPending=new Map<string,AbortController>();
const aroundLoaded=new Set<string>();
const detachedWsMessages=new Map<string,GroupDMMessage[]>();
const pendingAroundUpdates=new Map<string,Map<string,{version:number;message:GroupDMMessage}>>();
const pendingCreates=new Set<string>();
const preparingSends=new Set<string>();
const recoverySendOrigins=new Map<string,{id:string;durable?:DurableSendScope}>();
const membershipMutations=new Set<string>();
// File identity, not filename/size, ties reviewed originals to their source.
// Scope/epoch fencing prevents reuse after account or group lifetime changes.
const reviewedFileSources=new WeakMap<File,{groupId:string;accountId:string;source:Omit<GroupFileSource,"fileIndex">;current:()=>boolean}>();
let restoreRequest=0;
const retiredSends=new Set<string>();
const durableKey=(scope:DurableSendScope)=>JSON.stringify([accountEpoch,scope.accountId,scope.deviceId,scope.groupId,scope.id]);
function prefillRestoredDraft(groupId:string,pending:GroupPendingSend):GroupPendingSend{
  const key=composerKey(useAuthStore.getState().user?.id,"group",groupId),draft=useComposerDraftStore.getState().drafts[key]??EMPTY_DRAFT;
  if(!draft.content&&!draft.files.length&&!draft.groupEditingId&&!draft.sending&&!draft.groupReplyToId){useComposerDraftStore.getState().patch(key,{content:pending.content,files:[],groupReplyToId:pending.replyToId});return {...pending,draftRevision:useComposerDraftStore.getState().drafts[key].revision}}
  return {...pending,draftRevision:-1};
}
function hasRecoverySource(groupId:string,pending:GroupPendingSend):boolean{
  const state=useGroupDMStore.getState();
  if(pending.originRecoveryId&&state.uploadRecoveries[groupId]?.some(item=>item.id===pending.originRecoveryId))return true;
  const source=pending.originDurable;if(!source)return false;
  return [...(state.restoredQueue[groupId]??[]),...(state.uploadRecoveries[groupId]??[])].some(item=>item.durable?.id===source.id&&item.durable.deviceId===source.deviceId);
}
function captureAccount(){
  const {ownerId:owner, generation}=getAuthSessionSnapshot(),epoch=accountEpoch;
  return ()=>Boolean(owner && useAuthStore.getState().user?.id===owner && getAuthSessionSnapshot().ownerId===owner && getAuthSessionSnapshot().generation===generation && getAuthGeneration()===generation && epoch===accountEpoch);
}
function rememberRecoveryFiles(groupId:string,recovery:GroupUploadRecovery){
  if(!recovery.durable||recovery.sourceIndices?.length!==recovery.files.length)return;
  const scope=recovery.durable,account=captureAccount(),lifetime=groupLifetimes.get(groupId);
  recovery.files.forEach((file,index)=>reviewedFileSources.set(file,{groupId,accountId:scope.accountId,source:{deviceId:scope.deviceId,id:scope.id,sourceIndex:recovery.sourceIndices![index]},current:()=>account()&&groupLifetimes.get(groupId)===lifetime&&useGroupDMStore.getState().groups.some(g=>g.id===groupId)}));
}
function captureGroup(groupId:string):()=>boolean{
  const account=captureAccount(), lifetime=groupLifetimes.get(groupId), epoch=useGroupDMStore.getState().groups.find(g=>g.id===groupId)?.key_epoch;
  const {ownerId, generation}=getAuthSessionSnapshot();
  return ()=>account() && useGroupDMStore.getState().ownerId===ownerId && useGroupDMStore.getState().authGeneration===generation && epoch!==undefined && groupLifetimes.get(groupId)===lifetime && useGroupDMStore.getState().groups.some(g=>g.id===groupId&&g.key_epoch===epoch);
}
function mutateMessage(groupId:string,messageId:string):number {
  const versions=messageVersions.get(groupId)??new Map<string,number>();
  const version=++messageClock;versions.set(messageId,version);messageVersions.set(groupId,versions);return version;
}
function mergeHistory(groupId:string,fresh:GroupDMMessage[],current:GroupDMMessage[],started:number):GroupDMMessage[]{
  const safe=fresh.filter(m=>m.group_id===groupId && (messageVersions.get(groupId)?.get(m.id)??0)<=started);
  return sortGroupMessages([...new Map([...current,...safe].map(m=>[m.id,m])).values()]);
}
function sortGroupMessages(messages:GroupDMMessage[]):GroupDMMessage[]{
  const legacy=[...messages].sort((a,b)=>new Date(a.created_at).getTime()-new Date(b.created_at).getTime()||a.id.localeCompare(b.id));
  return sortDMBySource(legacy,new Map(legacy.map((m,index)=>[m.id,index])));
}
function mergeUniqueGroupMessages(...lists:GroupDMMessage[][]):GroupDMMessage[]{
  const merged=new Map<string,GroupDMMessage>();
  for(const message of lists.flat()){const previous=merged.get(message.id);merged.set(message.id,message.source_sequence===undefined&&dmSourceSequence(previous?.source_sequence)!==null?{...message,source_sequence:previous?.source_sequence}:message)}
  return sortGroupMessages([...merged.values()]);
}
function validReadState(read:GroupDMReadState):boolean {
  return Boolean(read.group_id)&&Number.isSafeInteger(read.unread_count)&&read.unread_count>=0
    &&(read.revision===undefined||(Number.isSafeInteger(read.revision)&&read.revision>=0))
    &&(read.settings_revision===undefined||(Number.isSafeInteger(read.settings_revision)&&read.settings_revision>=0&&typeof read.is_muted==="boolean"))
    &&(read.key_epoch===undefined||(Number.isSafeInteger(read.key_epoch)&&read.key_epoch>0))
    &&(read.last_read_source_sequence===undefined||read.last_read_source_sequence==="0"||dmSourceSequence(read.last_read_source_sequence)!==null);
}
function preserveNewerReadState(group:GroupDM,current:GroupDM|undefined):GroupDM {
  if(!current)return group;
  if(group.key_epoch<current.key_epoch)return current;
  if(group.key_epoch!==current.key_epoch)return group;
  if(current.read_key_epoch!==undefined&&group.read_key_epoch!==undefined&&group.read_key_epoch<current.read_key_epoch)return current;
  if(group.read_key_epoch!==undefined&&group.read_key_epoch!==current.read_key_epoch)return group;
  let merged=group;
  const unknownEpoch=current.read_key_epoch!==undefined&&group.read_key_epoch===undefined;
  if(unknownEpoch||(current.read_revision!==undefined&&(group.read_revision===undefined||group.read_revision<current.read_revision)))merged={...merged,unread_count:current.unread_count,read_revision:current.read_revision,last_read_source_sequence:current.last_read_source_sequence,oldest_unread_message_id:current.oldest_unread_message_id,read_key_epoch:current.read_key_epoch};
  if(unknownEpoch||(current.settings_revision!==undefined&&(group.settings_revision===undefined||group.settings_revision<current.settings_revision)))merged={...merged,is_muted:current.is_muted,settings_revision:current.settings_revision};
  return merged;
}

export const useGroupDMStore = create<GroupDMState>((set, get) => ({
  ownerId:getAuthSessionSnapshot().ownerId,authGeneration:getAuthSessionSnapshot().generation,groups: [], messages: {}, hasMoreAfterByGroup:{},scrollTarget:null,loading: false, error: null,uploadRecoveries:{},pendingSends:{},groupsReady:false,restoreStatus:"idle",restoreScope:null,restoreDeviceId:null,restoreBlocked:[],restoredQueue:{},
  restorePendingSends:async(force=false)=>{
    const account=captureAccount(),accountId=useAuthStore.getState().user?.id,deviceId=useE2EEStore.getState().localDeviceId;
    if(!accountId||!deviceId||!get().groupsReady||useE2EEStore.getState().initStatus!=="ready")return;
    const signature=()=>JSON.stringify(get().groups.map(group=>group.id).sort());
    const membership=signature(),scope=JSON.stringify([accountEpoch,accountId,deviceId,membership]);
    if(!force&&get().restoreScope===scope&&(get().restoreStatus==="ready"||get().restoreStatus==="loading"))return;
    const request=++restoreRequest;
    const isCurrent=()=>account()&&request===restoreRequest&&useE2EEStore.getState().localDeviceId===deviceId&&useE2EEStore.getState().initStatus==="ready"&&get().groupsReady&&signature()===membership;
    set({restoreStatus:"loading",restoreScope:scope,restoreDeviceId:deviceId,error:null});
    try{
      const plan=await loadGroupSendRestorePlan(accountId,deviceId,new Set(get().groups.map(group=>group.id)),isCurrent);
      if(!isCurrent())return;
      const pendingSends={...get().pendingSends},restoredQueue={...get().restoredQueue};
      for(const [groupId,snapshots]of Object.entries(plan.groups)){
        if(!isCurrent())return;
        const lifetime=groupLifetimes.get(groupId),known=new Set([pendingSends[groupId]?.id,...(restoredQueue[groupId]??[]).map(item=>item.id),...(get().uploadRecoveries[groupId]??[]).map(item=>item.durable?.id)]);
        const ownerCurrent=()=>account()&&groupLifetimes.get(groupId)===lifetime&&get().groups.some(group=>group.id===groupId);
        const current=()=>ownerCurrent()&&useE2EEStore.getState().localDeviceId===deviceId;
        const recovered:GroupPendingSend[]=[];
        for(const snapshot of snapshots){
          const durable={accountId,deviceId,groupId,id:snapshot.id};
          if(known.has(snapshot.id)||retiredSends.has(durableKey(durable)))continue;
          recovered.push({id:snapshot.id,busy:false,content:snapshot.content,files:snapshot.files,replyToId:snapshot.replyToId,payload:snapshot.payload,encrypted:snapshot.files.length?{files:snapshot.encryptedFiles,metas:snapshot.fileKeys!}:undefined,current,ownerCurrent,started:messageClock,draftRevision:-1,durable,stored:true,createdAt:snapshot.createdAt,restored:true,acknowledgedIndices:snapshot.acknowledgedIndices,fileSources:snapshot.fileSources,resultConfirmed:snapshot.resultConfirmed,lookupOnly:snapshot.resultConfirmed,originDurable:snapshot.origin?{accountId,deviceId:snapshot.origin.deviceId,groupId,id:snapshot.origin.id}:undefined});
        }
        const queue=[...(restoredQueue[groupId]??[]),...recovered];
        if(!pendingSends[groupId]&&queue.length)pendingSends[groupId]=prefillRestoredDraft(groupId,queue.shift()!);
        restoredQueue[groupId]=queue;
      }
      if(!isCurrent())return;
      set({pendingSends,restoredQueue,restoreBlocked:plan.blocked.map(item=>item.groupId),restoreStatus:"ready",error:plan.blocked.length?"groupSendRestoreBlocked":null});
    }catch{if(isCurrent())set({restoreStatus:"error",error:"groupSendRestoreFailed"})}
  },
  advancePendingSend:groupId=>{
    const queue=(get().restoredQueue[groupId]??[]).filter(item=>item.current()&&(!item.durable||!retiredSends.has(durableKey(item.durable))));
    const next=queue.shift();set(state=>({pendingSends:{...state.pendingSends,[groupId]:next?prefillRestoredDraft(groupId,next):undefined},restoredQueue:{...state.restoredQueue,[groupId]:queue}}));
  },
  prefillPendingDraft:groupId=>{
    const pending=get().pendingSends[groupId];if(!pending?.restored||!pending.current()||pending.draftRevision>=0)return;
    const next=prefillRestoredDraft(groupId,pending);if(next.draftRevision!==pending.draftRevision)set(state=>({pendingSends:{...state.pendingSends,[groupId]:next}}));
  },
  fetchGroups: async () => {
    const {ownerId, generation}=getAuthSessionSnapshot(),account=captureAccount(),request=++listRequest,started=groupProjectionClock;
    const isCurrent=()=>account()&&request===listRequest;
    if(!isCurrent())return;
    set({ loading: true, error: null });
    const res = await api.listGroupDMs({isCurrent,timeoutMs:15_000});
    if(!isCurrent())return;
    set(state=>{
      if(!res.success||!res.data)return {loading:false,error:res.error??"group_dm_load_failed"};
      const groups:GroupDM[]=[],seen=new Set<string>();
      for(const incoming of res.data.group_dms??[]){seen.add(incoming.id);const current=state.groups.find(group=>group.id===incoming.id);
        if((groupProjectionVersions.get(incoming.id)??0)>started){if(current)groups.push(current)}else groups.push(preserveNewerReadState(incoming,current));
      }
      for(const current of state.groups)if(!seen.has(current.id)&&(groupProjectionVersions.get(current.id)??0)>started)groups.push(current);
      return {ownerId,authGeneration:generation,groups,groupsReady:true,loading:false};
    });
  },
  create: async (name, userIds) => {
    const isCurrent=captureAccount();if(!isCurrent())return null;
    const res = await api.createGroupDM(name, userIds,{isCurrent,timeoutMs:15_000});
    if(!isCurrent())return null;
    if (!res.success || !res.data) { set({ error: res.error ?? "group_dm_create_failed" }); return null; }
    get().handleCreateOrUpdate(res.data);
    return res.data;
  },
  fetchMessages: async (groupId, options) => {
    const jump=Boolean(options?.jumpToPresent);
    if(!jump&&(aroundPending.has(groupId)||aroundLoaded.has(groupId)))return false;
    const groupCurrent=captureGroup(groupId),request=(historyRequests.get(groupId)??0)+1,started=messageClock;
    const ownerId=useAuthStore.getState().user?.id??null,authGeneration=getAuthGeneration(),deviceId=useE2EEStore.getState().localDeviceId;
    historyRequests.set(groupId,request);
    const isCurrent=()=>groupCurrent()&&historyRequests.get(groupId)===request&&getAuthGeneration()===authGeneration&&
      (useAuthStore.getState().user?.id??null)===ownerId&&useE2EEStore.getState().localDeviceId===deviceId;
    if(!isCurrent())return false;
    try{
      const res = await api.listGroupDMMessages(groupId,undefined,50,{isCurrent,timeoutMs:15_000});
      if(!isCurrent())return false;
      if (!res.success || !res.data) { set({ error: res.error ?? "group_dm_messages_failed" }); return false; }
      const loaded = await decryptGroupDMMessages((res.data.messages ?? []).filter(m=>m.group_id===groupId),isCurrent,m=>(messageVersions.get(groupId)?.get(m.id)??0)<=started);
      if(!isCurrent())return false;
      const messages=loaded.filter(m=>(messageVersions.get(groupId)?.get(m.id)??0)<=started);
      void registerSpamBatch(messages.map((message) => ({ ...message, content: message.content ?? null })), "group", groupId);
      if(!isCurrent())return false;
      if(jump){
        const current=get().messages[groupId]??[];
        const created=messageCreateVersions.get(groupId);
        const liveAfterStart=current.filter(message=>(created?.get(message.id)??0)>started);
        const held=detachedWsMessages.get(groupId)??[];
        const tail=mergeUniqueGroupMessages(messages,liveAfterStart,held);
        detachedWsMessages.delete(groupId);aroundLoaded.delete(groupId);
        set(state=>({messages:{...state.messages,[groupId]:tail},hasMoreAfterByGroup:{...state.hasMoreAfterByGroup,[groupId]:false},error:null}));
      }else{
        set((state) => ({ messages: { ...state.messages, [groupId]: mergeHistory(groupId,messages,state.messages[groupId]??[],started) } }));
      }
      return true;
    }catch{
      if(isCurrent())set({error:"group_dm_messages_failed"});
      return false;
    }
  },
  fetchMessagesAround: async (groupId,messageId,options) => {
    const groupCurrent=captureGroup(groupId),ownerId=useAuthStore.getState().user?.id??null;
    const authGeneration=getAuthGeneration(),deviceId=useE2EEStore.getState().localDeviceId;
    const externalCurrent=()=>{try{return options?.isCurrent?.()!==false}catch{return false}};
    if(!ownerId||!deviceId||!groupCurrent()||!externalCurrent())return false;
    aroundPending.get(groupId)?.abort();
    const controller=new AbortController(),request=(historyRequests.get(groupId)??0)+1,started=messageClock;
    historyRequests.set(groupId,request);aroundPending.set(groupId,controller);pendingAroundUpdates.set(groupId,new Map());
    const isCurrent=()=>!controller.signal.aborted&&groupCurrent()&&historyRequests.get(groupId)===request&&
      getAuthGeneration()===authGeneration&&(useAuthStore.getState().user?.id??null)===ownerId&&
      useE2EEStore.getState().localDeviceId===deviceId&&externalCurrent();
    const release=()=>{if(aroundPending.get(groupId)===controller)aroundPending.delete(groupId)};
    try{
      const res=await api.getGroupDMMessagesAround(groupId,messageId,50,{signal:controller.signal,timeoutMs:options?.timeoutMs??15_000,isCurrent});
      if(!isCurrent())return false;
      const page=res.success?res.data:undefined;
      const raw=(page?.messages??[]).filter(message=>message.group_id===groupId);
      if(!page||!raw.some(message=>message.id===messageId)){
        if(isCurrent())set({error:res.error??"group_dm_messages_failed"});
        return false;
      }
      const decrypted=await decryptGroupDMMessages(raw,isCurrent,message=>(messageVersions.get(groupId)?.get(message.id)??0)<=started);
      if(!isCurrent())return false;
      const fresh=decrypted.filter(message=>(messageVersions.get(groupId)?.get(message.id)??0)<=started);
      const current=get().messages[groupId]??[];
      const rawIDs=new Set(raw.map(message=>message.id));
      const newerWindow=current.filter(message=>rawIDs.has(message.id)&&(messageVersions.get(groupId)?.get(message.id)??0)>started);
      const inFlightUpdates=[...(pendingAroundUpdates.get(groupId)?.values()??[])]
        .filter(update=>update.version>started&&rawIDs.has(update.message.id)).map(update=>update.message);
      const latestWindow=mergeUniqueGroupMessages(fresh,newerWindow,inFlightUpdates);
      if(!latestWindow.some(message=>message.id===messageId))return false;
      const created=messageCreateVersions.get(groupId);
      const liveAfterStart=current.filter(message=>(created?.get(message.id)??0)>started&&!latestWindow.some(window=>window.id===message.id));
      const held=detachedWsMessages.get(groupId)??[];
      const hasMoreAfter=Boolean(page.has_more_after);
      const detached=hasMoreAfter?mergeUniqueGroupMessages(held,liveAfterStart):[];
      const visible=hasMoreAfter?latestWindow:mergeUniqueGroupMessages(latestWindow,held,liveAfterStart);
      if(hasMoreAfter)detachedWsMessages.set(groupId,detached);else detachedWsMessages.delete(groupId);
      aroundLoaded.add(groupId);
      void registerSpamBatch(fresh.map(message=>({...message,content:message.content??null})),"group",groupId);
      if(!isCurrent())return false;
      set(state=>({messages:{...state.messages,[groupId]:visible},hasMoreAfterByGroup:{...state.hasMoreAfterByGroup,[groupId]:hasMoreAfter},error:null}));
      return true;
    }catch{
      if(isCurrent())set({error:"group_dm_messages_failed"});
      return false;
    }finally{if(aroundPending.get(groupId)===controller){pendingAroundUpdates.delete(groupId);release()}}
  },
  jumpToPresent: groupId => {
    if(!get().hasMoreAfterByGroup[groupId])return;
    aroundPending.get(groupId)?.abort();
    aroundLoaded.add(groupId);
    set(state=>({hasMoreAfterByGroup:{...state.hasMoreAfterByGroup,[groupId]:true},scrollTarget:state.scrollTarget?.groupId===groupId?null:state.scrollTarget}));
    void get().fetchMessages(groupId,{jumpToPresent:true});
  },
  setScrollTarget: (groupId,messageId) => {
    if(!get().messages[groupId]?.some(message=>message.id===messageId)||!captureGroup(groupId)())return null;
    const request=++scrollTargetRequest,accountId=useAuthStore.getState().user?.id??"";
    set({scrollTarget:{groupId,messageId,request,accountId,authGeneration:getAuthGeneration()}});
    return request;
  },
  clearScrollTarget: request => set(state=>state.scrollTarget?.request===request?{scrollTarget:null}:state),
  searchMessages: async (groupId, query) => {
    const isCurrent=captureGroup(groupId),started=messageClock;if(!isCurrent())return [];
    let before: string | undefined;
    let all: GroupDMMessage[] = [];
    for (let page = 0; page < 100; page += 1) {
      const res = await api.listGroupDMMessages(groupId, before, 100,{isCurrent,timeoutMs:15_000});
      if(!isCurrent())return [];
      if (!res.success || !res.data) { set({ error: res.error ?? "group_dm_search_failed" }); break; }
      const decrypted = await decryptGroupDMMessages((res.data.messages ?? []).filter(m=>m.group_id===groupId),isCurrent,m=>(messageVersions.get(groupId)?.get(m.id)??0)<=started);
      if(!isCurrent())return [];
      all = [...decrypted, ...all];
      if (decrypted.length < 100) break;
      before = decrypted[0]?.id;
      if (!before) break;
    }
    const unique = mergeUniqueGroupMessages(all).filter(m=>(messageVersions.get(groupId)?.get(m.id)??0)<=started);
    void registerSpamBatch(unique.map((message) => ({ ...message, content: message.content ?? null })), "group", groupId);
    if(!isCurrent())return [];
    set((state) => ({messages:{...state.messages,[groupId]:mergeHistory(groupId,unique,state.messages[groupId]??[],started)}}));
    const normalized = query.trim().toLocaleLowerCase();
    return normalized ? unique.filter((message) => (message.content ?? "").toLocaleLowerCase().includes(normalized)) : unique;
  },
  send: async (groupId, rawContent, replyToId, files, context) => {
    const session=getAuthSessionSnapshot(),ownerId=useAuthStore.getState().user?.id??null;
    const callerCurrent=()=>!context||(context.ownerId===session.ownerId&&context.authGeneration===session.generation&&(!context.isCurrent||context.isCurrent()));
    if(!ownerId||!callerCurrent()||session.ownerId!==ownerId||get().ownerId!==ownerId||get().authGeneration!==session.generation){set({error:"groupSendContextChanged"});return false}
    const sendSessionCurrent=()=>callerCurrent()&&getAuthSessionSnapshot().ownerId===ownerId&&getAuthSessionSnapshot().generation===session.generation&&getAuthGeneration()===session.generation&&useAuthStore.getState().user?.id===ownerId&&get().ownerId===ownerId&&get().authGeneration===session.generation;
    if(!sendSessionCurrent())return false;
    if(useE2EEStore.getState().initStatus!=="ready"){set({error:"groupSendCryptoNotReady"});return false}
    if(!get().groupsReady||get().restoreStatus!=="ready"||get().restoreDeviceId!==useE2EEStore.getState().localDeviceId||get().restoreBlocked.includes(groupId)){set({error:"groupSendRestoreBlocked"});return false}
    const expectedRestoreScope=JSON.stringify([accountEpoch,useAuthStore.getState().user?.id,useE2EEStore.getState().localDeviceId,JSON.stringify(get().groups.map(group=>group.id).sort())]);
    if(get().restoreScope!==null&&get().restoreScope!==expectedRestoreScope){set({error:"groupSendRestoreBlocked"});return false}
    const lock=`${accountEpoch}:${groupId}`;
    if(preparingSends.has(lock))return false;
    const previous=get().pendingSends[groupId];
    // Explicit caller scopes represent a fresh intent (for example the overlay),
    // never permission to resume a prior uncertain/restored composer operation.
    if(context&&(previous||(get().restoredQueue[groupId]?.length??0)>0)){set({error:"groupSendPending"});return false}
    if(previous?.busy)return false;
    if(previous&&!previous.current()){set({error:"groupSendContextChanged"});return false}
    if(previous){
      if(rawContent.trim()!==previous.content||replyToId!==previous.replyToId||(files?.length??0)!==(previous.files?.length??0)||(files??[]).some((file,index)=>file!==previous.files?.[index])){set({error:"groupSendPending"});return false}
      rawContent=previous.content;replyToId=previous.replyToId;files=previous.files;
    }
    const groupCurrent=captureGroup(groupId);
    const content = rawContent.trim();
    const group = get().groups.find((item) => item.id === groupId);
    const currentUserId = useAuthStore.getState().user?.id;
    const localDeviceId = useE2EEStore.getState().localDeviceId;
    let isCurrent=()=>sendSessionCurrent()&&(previous?previous.current():groupCurrent()&&useE2EEStore.getState().localDeviceId===localDeviceId);
    if ((!content && !files?.length) || !group || !currentUserId || !localDeviceId || !isCurrent()) return false;
    if((files?.length??0)>10){set({error:"groupTooManyFiles"});return false}
    if(get().hasMoreAfterByGroup[groupId])get().jumpToPresent(groupId);
    set({error:null});
    preparingSends.add(lock);
    let attempt=previous;
    try {
      if(!attempt){
        const draftRevision=useComposerDraftStore.getState().drafts[composerKey(currentUserId,"group",groupId)]?.revision??0;
        const encrypted=files?.length?await encryptFilesForE2EE(files):undefined;
        if(!isCurrent())return false;
        const ciphertext=JSON.stringify(await encryptGroupDMMessage(currentUserId,group.members.map(member=>member.id),localDeviceId,encodePayload(content,encrypted?.metas)));
        if(!isCurrent())return false;
        const account=captureAccount(),lifetime=groupLifetimes.get(groupId);
        const ownerCurrent=()=>sendSessionCurrent()&&account()&&groupLifetimes.get(groupId)===lifetime&&get().groups.some(g=>g.id===groupId);
        const current=()=>ownerCurrent()&&useE2EEStore.getState().localDeviceId===localDeviceId;
        const id=crypto.randomUUID();
        const origin=recoverySendOrigins.get(groupId);
        attempt={id,busy:true,content,files,replyToId,encrypted,current,ownerCurrent,started:messageClock,draftRevision,originRecoveryId:origin?.id,originDurable:origin?.durable,durable:{accountId:currentUserId,deviceId:localDeviceId,groupId,id},stored:false,createdAt:Date.now(),payload:{ciphertext,sender_device_id:localDeviceId,e2ee_metadata:JSON.stringify({key_epoch:group.key_epoch}),key_epoch:group.key_epoch,reply_to_id:replyToId,client_request_id:id}};
        attempt.fileSources=(files??[]).flatMap((file,fileIndex)=>{const ref=reviewedFileSources.get(file);return ref?.groupId===groupId&&ref.accountId===currentUserId&&ref.current()?[{...ref.source,fileIndex}]:[]});
      }
      const active=attempt;
      isCurrent=()=>active.current()&&get().pendingSends[groupId]?.id===active.id;
      set(state=>({pendingSends:{...state.pendingSends,[groupId]:{...active,busy:true}}}));
      const encrypted=active.encrypted;
      if(!active.stored&&!active.lookupOnly&&active.durable){
        try{
          await savePendingGroupSend({...active.durable,createdAt:active.createdAt??Date.now(),content:active.content,payload:active.payload,replyToId:active.replyToId,files:active.files??[],encryptedFiles:encrypted?.files??[],fileKeys:encrypted?.metas,fileSources:active.fileSources,originRecoveryId:active.originRecoveryId,origin:active.originDurable?{deviceId:active.originDurable.deviceId,id:active.originDurable.id}:undefined},isCurrent);
        }catch{if(isCurrent())set({error:"groupSendStorageFailed"});return false}
        if(!isCurrent())return false;active.stored=true;
        set(state=>({pendingSends:{...state.pendingSends,[groupId]:{...active,busy:true}}}));
      }
      if(!isCurrent())return false;
      let res=previous?await retryGroupSend(groupId,active.payload,encrypted?.files,isCurrent,!active.lookupOnly):await api.sendGroupDMMessage(groupId,active.payload,encrypted?.files,{isCurrent,timeoutMs:60_000});
      if(!isCurrent())return false;
      if(res.success&&res.data&&"operation" in res.data)res=groupOutcomeResponse(res.data,groupId,active.id);
      if(res.status===202){set({error:"groupSendPending"});return false}
      if(res.status===410){
        const cancelled=res.code==="SEND_CANCELLED"||res.error==="groupSendCancelled";
        const draft=useComposerDraftStore.getState().drafts[composerKey(currentUserId,"group",groupId)],missing=(files??[]).filter(file=>!draft?.files.includes(file));
        if(missing.length&&!hasRecoverySource(groupId,active)){const recovery:GroupUploadRecovery={id:`upload-recovery-${++recoveryCounter}`,messageId:"",files:missing,replyToId,retrying:false,retryable:false,cancelled,durable:active.durable};set(state=>({uploadRecoveries:{...state.uploadRecoveries,[groupId]:[...(state.uploadRecoveries[groupId]??[]),recovery]}}))}
        else if(active.durable){try{await removePendingGroupSend(active.durable.accountId,active.durable.deviceId,groupId,active.id)}catch{if(isCurrent())set({error:"groupSendCleanupFailed"});return false}}
        if(isCurrent()){if(active.durable)retiredSends.add(durableKey(active.durable));get().advancePendingSend(groupId);set({error:cancelled?"groupSendCancelled":"groupSendDeleted"})}return false;
      }
      const wrapped=res.data&&"upload_failures" in res.data?res.data:undefined;
      const sent=wrapped?.message??(res.data as GroupDMMessage|undefined);
      if (!res.success || !sent || sent.group_id!==groupId || sent.user_id!==currentUserId) { set({ error: active.resultConfirmed?"groupSendCommittedLookupPending":res.error ?? "group_dm_send_failed" }); return false; }
      // Once a committed result has been observed, local receipt/cleanup
      // failures must never make this live attempt eligible for another POST.
      active.resultConfirmed=true;active.lookupOnly=true;
      set(state=>({pendingSends:{...state.pendingSends,[groupId]:{...state.pendingSends[groupId]!,resultConfirmed:true,lookupOnly:true}}}));
      const untouched=()=>(messageVersions.get(groupId)?.get(sent.id)??0)<=active.started;
      let next:GroupDMMessage|undefined;
      if(sent.ciphertext===active.payload.ciphertext){
        try{if(untouched())await cacheGroupMessage(sent,{content,file_keys:encrypted?.metas},()=>isCurrent()&&untouched())}catch{console.warn("[groupDM] committed message cache write failed")}
        next={...sent,content,e2ee_file_keys:encrypted?.metas};
      }else [next]=await decryptGroupDMMessages([sent],()=>isCurrent()&&untouched());
      if(!isCurrent())return false;
      if(next&&untouched()){
        const resolved=next;mutateMessage(groupId,sent.id);
        const created=messageCreateVersions.get(groupId)??new Map<string,number>();created.set(sent.id,messageVersions.get(groupId)?.get(sent.id)??messageClock);messageCreateVersions.set(groupId,created);
        if(get().hasMoreAfterByGroup[groupId])detachedWsMessages.set(groupId,mergeUniqueGroupMessages(detachedWsMessages.get(groupId)??[],[resolved]));
        else set(state=>{const current=state.messages[groupId]??[];return {messages:{...state.messages,[groupId]:mergeUniqueGroupMessages(current.filter(item=>item.id!==resolved.id),[resolved])}}});
      }
      let outstandingPartial=Boolean(wrapped||res.status===207);
      if(outstandingPartial){
        const failures=Array.isArray(wrapped?.upload_failures)?wrapped.upload_failures:[];
        const failed=new Set<number>();let known=Boolean(failures.length);
        const successful=new Set((sent.attachments??[]).map((a,index)=>groupAttachmentKeyIndex(a,index)));
        for(const failure of failures){
          if(!failure || typeof failure!=="object"){known=false;continue}
          const index=groupAttachmentKeyIndex({filename:failure.filename,file_key_index:failure.file_key_index},-1);
          if(index===undefined || index>=(files?.length??0) || successful.has(index))known=false;else failed.add(index);
        }
        const acknowledged=new Set(active.acknowledgedIndices??[]),sourceIndices=known?Array.from(failed).filter(index=>!acknowledged.has(index)).sort((a,b)=>a-b):undefined;
        const recoveryFiles=sourceIndices?sourceIndices.map(index=>files![index]):files??[];
        if(recoveryFiles.length){
          const recovery:GroupUploadRecovery={id:`upload-recovery-${++recoveryCounter}`,messageId:sent.id,files:recoveryFiles,replyToId,retrying:false,retryable:known,durable:active.durable,sourceIndices};
          set(state=>({uploadRecoveries:{...state.uploadRecoveries,[groupId]:[...(state.uploadRecoveries[groupId]??[]).filter(item=>!active.durable||item.durable?.id!==active.id||item.durable.deviceId!==active.durable.deviceId),recovery]}}));
        }else if(known&&failed.size>0)outstandingPartial=false;else set({error:"groupUploadOutcomeUnknown"});
      }
      if(previous){
        const draftKey=composerKey(currentUserId,"group",groupId),draft=useComposerDraftStore.getState().drafts[draftKey];
        const expectedFiles=active.restored?[]:files??[];
        if(draft&&!draft.sending&&!draft.groupEditingId&&draft.revision===active.draftRevision&&draft.content.trim()===content&&draft.groupReplyToId===replyToId&&draft.files.length===expectedFiles.length&&draft.files.every((file,index)=>file===expectedFiles[index]))useComposerDraftStore.getState().patch(draftKey,{content:"",files:[],groupReplyToId:undefined});
      }
      try{
        if(active.durable&&active.stored)await markPendingGroupSendConfirmed(currentUserId,active.durable.deviceId,groupId,active.id,isCurrent);
        if(!isCurrent())return true;
        // Persist receipts before deleting the child. A failed local write keeps
        // the committed child pending so result lookup can retry, never resend.
        if(active.fileSources?.length){
          if(sent.ciphertext!==active.payload.ciphertext)throw new Error("groupSendSourceVersionChanged");
          const successful=new Set((sent.attachments??[]).map((attachment,index)=>groupAttachmentKeyIndex(attachment,index)));
          const failed=(wrapped?.upload_failures??[]).map(failure=>groupAttachmentKeyIndex({filename:failure.filename,file_key_index:failure.file_key_index},-1));
          const count=active.files?.length??0;
          if(successful.size!==(sent.attachments??[]).length||[...successful,...failed].some(index=>index===undefined||index<0||index>=count)||new Set(failed).size!==failed.length||failed.some(index=>successful.has(index))||successful.size+failed.length!==count)throw new Error("groupUploadOutcomeUnknown");
          const receipts=new Map<string,{source:GroupFileSource;indices:number[]}>();
          for(const source of active.fileSources)if(successful.has(source.fileIndex)){
            const key=JSON.stringify([source.deviceId,source.id]),entry=receipts.get(key)??{source,indices:[]};entry.indices.push(source.sourceIndex);receipts.set(key,entry);
          }
          for(const {source,indices}of receipts.values()){
            const updates=await acknowledgePendingGroupFileChain(currentUserId,source.deviceId,groupId,source.id,indices,isCurrent);
            if(!isCurrent())return true;
            set(state=>({restoredQueue:{...state.restoredQueue,[groupId]:(state.restoredQueue[groupId]??[]).map(item=>{const update=updates.find(u=>u.id===item.id&&u.deviceId===item.durable?.deviceId);return update?{...item,acknowledgedIndices:update.acknowledgedIndices}:item})}}));
          }
        }
        // New provenance chains still need their ancestors after a partial
        // retry. Legacy operations without mappings retain their old cleanup.
        if(active.originDurable&&!active.fileSources?.length)await removePendingGroupSend(active.originDurable.accountId,active.originDurable.deviceId,groupId,active.originDurable.id);
        if(!outstandingPartial&&active.durable)await removePendingGroupSend(active.durable.accountId,active.durable.deviceId,groupId,active.id);
      }catch{if(isCurrent())set({error:active.fileSources?.length?"groupSendSourceRecoveryFailed":"groupSendCleanupFailed"});return true}
      if(!isCurrent())return true;
      if(active.durable)retiredSends.add(durableKey(active.durable));if(active.originDurable&&!active.fileSources?.length)retiredSends.add(durableKey(active.originDurable));
      if(active.originRecoveryId)get().dismissUploadRecovery(groupId,active.originRecoveryId,true);
      get().advancePendingSend(groupId);
      return true;
    } catch (error) {
      if(isCurrent())set({ error: error instanceof Error ? error.message : "group_dm_send_failed" });
      return false;
    }finally{
      preparingSends.delete(lock);
      if(attempt)set(state=>{const pending=state.pendingSends[groupId];return pending&&pending.id===attempt?.id?{pendingSends:{...state.pendingSends,[groupId]:{...pending,busy:false}}}:{}});
    }
  },
  retryPendingSend:async groupId=>{
    const pending=get().pendingSends[groupId];if(!pending||pending.busy)return false;
    if(!pending.current()){
      if(!pending.ownerCurrent?.())return false;
      // Ownership permits reading/finalizing the old operation, not resuming
      // its old-device ciphertext. Keep this fence for every later attempt.
      set(state=>({pendingSends:{...state.pendingSends,[groupId]:{...pending,current:pending.ownerCurrent!,lookupOnly:true}}}));
    }
    return get().send(groupId,pending.content,pending.replyToId,pending.files);
  },
  cancelPendingSend:async groupId=>{
    const pending=get().pendingSends[groupId];if(!pending||pending.busy)return false;
    const owner=pending.ownerCurrent??pending.current;
    const isCurrent=()=>owner()&&get().pendingSends[groupId]?.id===pending.id;
    if(!isCurrent())return false;
    set(state=>({pendingSends:{...state.pendingSends,[groupId]:{...pending,busy:true}},error:null}));
    try{
      const response=await api.cancelGroupSend(groupId,pending.id,{isCurrent,timeoutMs:15_000});
      if(!isCurrent())return false;
      const normalized=response.success&&response.data?groupOutcomeResponse(response.data,groupId,pending.id):undefined;
      if(normalized?.status===410&&normalized.error==="groupSendCancelled"){
        const draft=useComposerDraftStore.getState().drafts[composerKey(useAuthStore.getState().user?.id,"group",groupId)];
        const missing=(pending.files??[]).filter(file=>!draft?.files.includes(file));
        const sourcePresent=hasRecoverySource(groupId,pending);
        if(missing.length&&!sourcePresent){const recovery:GroupUploadRecovery={id:`upload-recovery-${++recoveryCounter}`,messageId:"",files:missing,replyToId:pending.replyToId,retrying:false,retryable:false,cancelled:true,durable:pending.durable};set(state=>({uploadRecoveries:{...state.uploadRecoveries,[groupId]:[...(state.uploadRecoveries[groupId]??[]).filter(item=>!pending.durable||item.durable?.id!==pending.id),recovery]}}))}
        if((!missing.length||sourcePresent)&&pending.durable){try{await removePendingGroupSend(pending.durable.accountId,pending.durable.deviceId,groupId,pending.id)}catch{if(isCurrent())set({error:"groupSendCleanupFailed"});return false}}
        if(!isCurrent())return false;
        if(pending.durable)retiredSends.add(durableKey(pending.durable));get().advancePendingSend(groupId);set({error:"groupSendCancelled"});return true;
      }
      set({error:normalized?.success?"groupSendAlreadyCommitted":response.error??normalized?.error??"groupSendCancelFailed"});return false;
    }catch{if(isCurrent())set({error:"groupSendCancelFailed"});return false}
    finally{set(state=>{const active=state.pendingSends[groupId];return active?.id===pending.id?{pendingSends:{...state.pendingSends,[groupId]:{...active,busy:false}}}:{}})}
  },
  retryUploadRecovery:async(groupId,id)=>{
    const account=captureAccount(),lifetime=groupLifetimes.get(groupId),recovery=get().uploadRecoveries[groupId]?.find(item=>item.id===id);
    if(!account()||!recovery||recovery.retrying||!recovery.retryable)return false;
    const current=()=>account()&&groupLifetimes.get(groupId)===lifetime&&get().groups.some(g=>g.id===groupId);
    if(!current())return false;
    set(state=>({uploadRecoveries:{...state.uploadRecoveries,[groupId]:(state.uploadRecoveries[groupId]??[]).map(item=>item.id===id?{...item,retrying:true}:item)}}));
    let committed=false;
    rememberRecoveryFiles(groupId,recovery);
    recoverySendOrigins.set(groupId,{id,durable:recovery.durable});
    try{committed=await get().send(groupId,"",recovery.replyToId,recovery.files)}catch{if(current())set({error:"groupUploadRetryFailed"})}finally{if(recoverySendOrigins.get(groupId)?.id===id)recoverySendOrigins.delete(groupId)}
    if(!current())return false;
    if(!committed&&get().pendingSends[groupId])set(state=>({pendingSends:{...state.pendingSends,[groupId]:{...state.pendingSends[groupId]!,originRecoveryId:id}}}));
    if(!committed&&!get().error)set({error:"groupUploadRetryFailed"});
    set(state=>({uploadRecoveries:{...state.uploadRecoveries,[groupId]:(state.uploadRecoveries[groupId]??[]).flatMap(item=>item.id!==id?[item]:committed?[]:[{...item,retrying:false}])}}));
    return committed;
  },
  restoreUploadRecovery:(groupId,id)=>{
    const recovery=get().uploadRecoveries[groupId]?.find(item=>item.id===id),account=captureAccount();
    if(!account()||!get().groups.some(g=>g.id===groupId)||!recovery||recovery.retrying)return false;
    const key=composerKey(useAuthStore.getState().user?.id,"group",groupId),store=useComposerDraftStore.getState(),draft=store.drafts[key]??EMPTY_DRAFT;
    const files=[...new Set([...draft.files,...recovery.files])];
    if(draft.sending||draft.groupEditingId||files.length>10){set({error:"groupReviewFilesBlocked"});return false}
    rememberRecoveryFiles(groupId,recovery);
    store.patch(key,{files});get().dismissUploadRecovery(groupId,id,true);set({error:null});return true;
  },
  dismissUploadRecovery:(groupId,id,preserveDurable)=>{
    const recovery=get().uploadRecoveries[groupId]?.find(item=>item.id===id);if(!recovery||recovery.retrying)return;
    set(state=>({uploadRecoveries:{...state.uploadRecoveries,[groupId]:(state.uploadRecoveries[groupId]??[]).filter(item=>item.id!==id)}}));
    if(recovery.durable&&!preserveDurable){const account=captureAccount(),scope=recovery.durable;void removePendingGroupSend(scope.accountId,scope.deviceId,groupId,scope.id).catch(()=>{if(account()&&get().groups.some(g=>g.id===groupId))set(state=>({error:"groupSendCleanupFailed",uploadRecoveries:{...state.uploadRecoveries,[groupId]:[...(state.uploadRecoveries[groupId]??[]),recovery]}}))})}
  },
  edit: async (groupId, messageId, rawContent) => {
    const groupCurrent=captureGroup(groupId);
    const content=rawContent.trim(), group=get().groups.find((item)=>item.id===groupId), currentUserId=useAuthStore.getState().user?.id, localDeviceId=useE2EEStore.getState().localDeviceId;
    const original=get().messages[groupId]?.find(m=>m.id===messageId);
    const isCurrent=()=>groupCurrent()&&useE2EEStore.getState().localDeviceId===localDeviceId;
    if(!content||!group||!currentUserId||!localDeviceId||!isCurrent()||!original||original.user_id!==currentUserId||original.content===null)return false;
    set({error:null});
    try{
      const ciphertext=JSON.stringify(await encryptGroupDMMessage(currentUserId,group.members.map((m)=>m.id),localDeviceId,encodePayload(content,original.e2ee_file_keys)));
      if(!isCurrent())return false;
      const res=await api.editGroupDMMessage(groupId,messageId,{ciphertext,sender_device_id:localDeviceId,e2ee_metadata:JSON.stringify({key_epoch:group.key_epoch}),key_epoch:group.key_epoch},{isCurrent,timeoutMs:30_000});
      if(!isCurrent())return false;
      if(!res.success||!res.data||res.data.group_id!==groupId||res.data.id!==messageId){set({error:res.error??"group_dm_edit_failed"});return false}
      try{await cacheGroupMessage(res.data,{content,file_keys:original.e2ee_file_keys},isCurrent)}catch{console.warn("[groupDM] committed edit cache write failed")}
      if(!isCurrent())return false;
      mutateMessage(groupId,messageId);
      set((s)=>({messages:{...s.messages,[groupId]:(s.messages[groupId]??[]).map((m)=>m.id===messageId?{...res.data!,content,e2ee_file_keys:original.e2ee_file_keys}:m)}}));return true;
    }catch(error){if(isCurrent())set({error:error instanceof Error?error.message:"group_dm_edit_failed"});return false}
  },
  removeMessage: async(groupId,messageId)=>{const res=await api.deleteGroupDMMessage(groupId,messageId);if(!res.success){set({error:res.error??"group_dm_delete_failed"});return false};get().handleMessageDelete(groupId,messageId);return true},
  toggleReaction: async(groupId,messageId,emoji)=>{const res=await api.toggleGroupDMReaction(groupId,messageId,emoji);if(!res.success){set({error:res.error??"group_dm_reaction_failed"});return false};return true},
  markRead: async(groupId,messageId)=>{
    const groupCurrent=captureGroup(groupId),group=get().groups.find(g=>g.id===groupId);
    const epoch=group?.read_key_epoch===undefined?undefined:group.key_epoch;
    const owner=useAuthStore.getState().user;if(!owner||!groupCurrent())return;
    const request=(readRequests.get(groupId)??0)+1;readRequests.set(groupId,request);
    const isCurrent=()=>groupCurrent()&&useAuthStore.getState().user===owner&&readRequests.get(groupId)===request;
    const res=await api.markGroupDMRead(groupId,messageId,{isCurrent,...(epoch===undefined?{}:{expectedKeyEpoch:epoch})});
    if(!isCurrent())return;
    if(res.success && res.data?.group_id===groupId && validReadState(res.data)&&(res.data.key_epoch===undefined?epoch===undefined:res.data.key_epoch===group?.key_epoch)){get().handleReadState(res.data);return}
    // Older servers returned 204. Only legacy (unrevisioned) groups may use it.
    if(res.success && !res.data && get().groups.find(g=>g.id===groupId)?.read_revision===undefined){get().handleReadState({group_id:groupId,last_read_message_id:messageId??null,unread_count:0});return}
    set({error:res.error??"group_dm_read_failed"});
  },
  markUnread: async(groupId,messageId)=>{
    const groupCurrent=captureGroup(groupId),group=get().groups.find(g=>g.id===groupId);
    const epoch=group?.read_key_epoch===undefined?undefined:group.key_epoch;
    const owner=useAuthStore.getState().user;if(!owner||!messageId||!groupCurrent())return false;
    const request=(readRequests.get(groupId)??0)+1;readRequests.set(groupId,request);
    const isCurrent=()=>groupCurrent()&&useAuthStore.getState().user===owner&&readRequests.get(groupId)===request;
    const res=await api.markGroupDMUnread(groupId,messageId,{isCurrent,...(epoch===undefined?{}:{expectedKeyEpoch:epoch})});
    if(!isCurrent())return false;
    if(!res.success || !res.data || res.data.group_id!==groupId || res.data.revision===undefined || !validReadState(res.data)||(res.data.key_epoch===undefined?epoch!==undefined:res.data.key_epoch!==group?.key_epoch)){set({error:res.error??"group_dm_unread_failed"});return false}
    get().handleReadState(res.data);return true;
  },
  handleReadState: read=>{
    if(!validReadState(read))return;
    set(state=>({groups:state.groups.map(group=>{
      if(group.id!==read.group_id||(read.key_epoch!==undefined&&read.key_epoch!==group.key_epoch)||(group.read_key_epoch!==undefined&&read.key_epoch===undefined))return group;
      const changed=read.key_epoch!==undefined&&read.key_epoch!==group.read_key_epoch;
      let next=!changed&&group.read_revision!==undefined&&(read.revision===undefined||read.revision<=group.read_revision)?group:{...group,unread_count:read.unread_count,read_revision:read.revision,last_read_source_sequence:read.last_read_source_sequence,oldest_unread_message_id:read.oldest_unread_message_id,read_key_epoch:read.key_epoch};
      if(read.settings_revision!==undefined&&(changed||group.settings_revision===undefined||read.settings_revision>group.settings_revision))next={...next,is_muted:read.is_muted,settings_revision:read.settings_revision};
      return next;
    })}));
  },
  setMuted:async(groupId,muted)=>{
    const current=captureGroup(groupId),ownerId=getAuthSessionSnapshot().ownerId,group=get().groups.find(g=>g.id===groupId);
    const epoch=group?.read_key_epoch===undefined?undefined:group.key_epoch;
    if(!ownerId||!current())return false;
    try{const res=await api.setGroupDMMuted(groupId,muted,{expectedUserId:ownerId,isCurrent:current,...(epoch===undefined?{}:{expectedKeyEpoch:epoch})});
      if(!current()||!res.success||!res.data||res.data.group_id!==groupId||!validReadState(res.data)||res.data.settings_revision===undefined||res.data.is_muted!==muted||(res.data.key_epoch===undefined?epoch!==undefined:res.data.key_epoch!==group?.key_epoch))return false;
      get().handleReadState(res.data);return true;
    }catch{return false}
  },
  leave: async (groupId) => {
    const currentUserId=useAuthStore.getState().user?.id,groupCurrent=captureGroup(groupId),authGeneration=getAuthGeneration(),lock=`${accountEpoch}:${groupId}`;
    const isCurrent=()=>groupCurrent()&&authGeneration===getAuthGeneration();
    if(!currentUserId||!isCurrent()||membershipMutations.has(lock))return false;
    membershipMutations.add(lock);
    try{
      if(!isCurrent())return false;
      const res=await api.leaveGroupDM(groupId,{expectedUserId:currentUserId,isCurrent});
      if(!isCurrent()||!res.success)return false;
      get().handleDelete(groupId);
      return true;
    }catch{return false}
    finally{membershipMutations.delete(lock)}
  },
  addMember: async (groupId, userId) => {
    const before=get().groups.find(group=>group.id===groupId),currentUserId=useAuthStore.getState().user?.id,groupCurrent=captureGroup(groupId),authGeneration=getAuthGeneration(),lock=`${accountEpoch}:${groupId}`;
    const isCurrent=()=>groupCurrent()&&authGeneration===getAuthGeneration();
    if(!before||!currentUserId||before.owner_id!==currentUserId||before.members.some(member=>member.id===userId)||before.members.length>=10||!isCurrent()||membershipMutations.has(lock))return false;
    membershipMutations.add(lock);
    try{
      if(!isCurrent())return false;
      const res=await api.addGroupDMMember(groupId,userId,{expectedUserId:currentUserId,isCurrent});
      if(!isCurrent()||!res.success||!res.data||res.data.id!==groupId||res.data.key_epoch<=before.key_epoch||!res.data.members.some(member=>member.id===userId))return false;
      get().handleCreateOrUpdate(res.data);
      return true;
    }catch{return false}
    finally{membershipMutations.delete(lock)}
  },
  removeMember: async (groupId, userId) => {
    const before=get().groups.find(group=>group.id===groupId),currentUserId=useAuthStore.getState().user?.id,groupCurrent=captureGroup(groupId),authGeneration=getAuthGeneration(),lock=`${accountEpoch}:${groupId}`;
    const isCurrent=()=>groupCurrent()&&authGeneration===getAuthGeneration();
    if(!before||!currentUserId||before.owner_id!==currentUserId||userId===currentUserId||!before.members.some(member=>member.id===userId)||!isCurrent()||membershipMutations.has(lock))return false;
    membershipMutations.add(lock);
    try{
      if(!isCurrent())return false;
      const res=await api.removeGroupDMMember(groupId,userId,{expectedUserId:currentUserId,isCurrent});
      if(!isCurrent()||!res.success||!res.data||res.data.id!==groupId||res.data.key_epoch<=before.key_epoch||res.data.members.some(member=>member.id===userId))return false;
      get().handleCreateOrUpdate(res.data);
      return true;
    }catch{return false}
    finally{membershipMutations.delete(lock)}
  },
  handleCreateOrUpdate: group=>{
    const previous=get().groups.find(item=>item.id===group.id);if(previous&&group.key_epoch<previous.key_epoch)return;
    groupProjectionVersions.set(group.id,++groupProjectionClock);
    set(state=>({groups:[preserveNewerReadState(group,state.groups.find(item=>item.id===group.id)),...state.groups.filter(item=>item.id!==group.id)]}));
  },
  handleDelete: (groupId) => {
    groupProjectionVersions.set(groupId,++groupProjectionClock);
    groupLifetimes.set(groupId,(groupLifetimes.get(groupId)??0)+1);messageVersions.delete(groupId);messageCreateVersions.delete(groupId);historyRequests.delete(groupId);aroundPending.get(groupId)?.abort();aroundPending.delete(groupId);aroundLoaded.delete(groupId);detachedWsMessages.delete(groupId);pendingAroundUpdates.delete(groupId);
    set((state) => { const messages = { ...state.messages },hasMoreAfterByGroup={...state.hasMoreAfterByGroup},uploadRecoveries={...state.uploadRecoveries},pendingSends={...state.pendingSends},restoredQueue={...state.restoredQueue}; delete messages[groupId];delete hasMoreAfterByGroup[groupId];delete uploadRecoveries[groupId];delete pendingSends[groupId];delete restoredQueue[groupId]; return { groups: state.groups.filter((item) => item.id !== groupId), messages,hasMoreAfterByGroup,scrollTarget:state.scrollTarget?.groupId===groupId?null:state.scrollTarget,uploadRecoveries,pendingSends,restoredQueue }; });
  },
  handleMessage: async (message):Promise<GroupMessageAcceptance> => {
    const rejected={status:"rejected"} as const;
    const current=captureGroup(message.group_id),key=JSON.stringify([accountEpoch,message.group_id,message.id]);
    const group=get().groups.find(g=>g.id===message.group_id),deviceId=useE2EEStore.getState().localDeviceId;
    const {ownerId,generation}=getAuthSessionSnapshot(),lifetime=groupLifetimes.get(message.group_id);
    if(!current()||!ownerId||!get().groupsReady||!group?.members.some(member=>member.id===ownerId)||!deviceId||useE2EEStore.getState().initStatus!=="ready"
      ||message.key_epoch!==group.key_epoch||typeof message.id!=="string"||!message.id||message.id.length>128||typeof message.user_id!=="string"||!message.user_id||message.user_id.length>128
      ||pendingCreates.has(key)||messageVersions.get(message.group_id)?.has(message.id)||get().messages[message.group_id]?.some(m=>m.id===message.id)||detachedWsMessages.get(message.group_id)?.some(m=>m.id===message.id))return rejected;
    const version=mutateMessage(message.group_id,message.id);
    const created=messageCreateVersions.get(message.group_id)??new Map<string,number>();created.set(message.id,version);messageCreateVersions.set(message.group_id,created);
    const isCurrent=():boolean=>current()&&useE2EEStore.getState().localDeviceId===deviceId&&useE2EEStore.getState().initStatus==="ready"
      &&get().groupsReady&&get().groups.some(g=>g.id===message.group_id&&g.members.some(member=>member.id===ownerId))&&messageVersions.get(message.group_id)?.get(message.id)===version;
    pendingCreates.add(key);
    let decrypted:GroupDMMessage|undefined;
    try{
      const pending=get().pendingSends[message.group_id];
      if(pending?.current()&&message.user_id===useAuthStore.getState().user?.id&&message.ciphertext===pending.payload.ciphertext){
        try{await cacheGroupMessage(message,{content:pending.content,file_keys:pending.encrypted?.metas},isCurrent)}catch{console.warn("[groupDM] committed message cache write failed")}
        decrypted={...message,content:pending.content,e2ee_file_keys:pending.encrypted?.metas};
      }else [decrypted]=await decryptGroupDMMessages([message],isCurrent);
    }catch{return rejected}finally{pendingCreates.delete(key)}
    if(!isCurrent() || !decrypted||decrypted.id!==message.id||decrypted.group_id!==message.group_id||decrypted.user_id!==message.user_id||decrypted.key_epoch!==message.key_epoch)return rejected;
    const accepted=(storage:"visible"|"detached"):GroupMessageAcceptance=>({status:"accepted",ownerId,authGeneration:generation,groupId:message.group_id,messageId:message.id,keyEpoch:group.key_epoch,deviceId,lifetime,sourceVersion:version,storage,message:decrypted!,previewReady:typeof decrypted!.content==="string"&&!decrypted!.decryption_error,isCurrent});
    if (decrypted) void registerSpamMessage({ ...decrypted, content: decrypted.content ?? null }, "group", message.group_id);
    if(get().hasMoreAfterByGroup[message.group_id]){
      const held=detachedWsMessages.get(message.group_id)??[];
      if(!held.some(item=>item.id===message.id))detachedWsMessages.set(message.group_id,[...held,decrypted]);
      return accepted("detached");
    }
    set((state) => {
      const current = state.messages[message.group_id] ?? [];
      if (current.some((item) => item.id === message.id)) return state;
      return { messages: { ...state.messages, [message.group_id]: mergeUniqueGroupMessages(current,[decrypted]) } };
    });
    return isCurrent()?accepted("visible"):rejected;
  },
  handleMessageUpdate: async (message) => {
    const current=captureGroup(message.group_id);if(!current())return;
    const visible=get().messages[message.group_id]??[],held=detachedWsMessages.get(message.group_id)??[];
    if(get().hasMoreAfterByGroup[message.group_id]&&!aroundPending.has(message.group_id)&&!visible.some(item=>item.id===message.id)&&!held.some(item=>item.id===message.id))return;
    const version=mutateMessage(message.group_id,message.id),isCurrent=()=>current()&&messageVersions.get(message.group_id)?.get(message.id)===version;
    const [decrypted] = await decryptGroupDMMessages([message],isCurrent);
    if (!isCurrent() || !decrypted) return;
    void registerSpamMessage({ ...decrypted, content: decrypted.content ?? null }, "group", message.group_id);
    if(aroundPending.has(message.group_id)&&!get().messages[message.group_id]?.some(item=>item.id===message.id)){
      const updates=pendingAroundUpdates.get(message.group_id)??new Map<string,{version:number;message:GroupDMMessage}>();
      updates.set(message.id,{version,message:decrypted});pendingAroundUpdates.set(message.group_id,updates);return;
    }
    if(get().hasMoreAfterByGroup[message.group_id]&&!get().messages[message.group_id]?.some(item=>item.id===message.id)){
      detachedWsMessages.set(message.group_id,mergeUniqueGroupMessages(detachedWsMessages.get(message.group_id)??[],[decrypted]));return;
    }
    set((state) => ({ messages: { ...state.messages, [message.group_id]: mergeUniqueGroupMessages((state.messages[message.group_id]??[]).filter(item=>item.id!==message.id),[decrypted]) } }));
  },
  handleMessageDelete:(groupId,messageId)=>{mutateMessage(groupId,messageId);detachedWsMessages.set(groupId,(detachedWsMessages.get(groupId)??[]).filter(message=>message.id!==messageId));set((s)=>({messages:{...s.messages,[groupId]:(s.messages[groupId]??[]).filter((m)=>m.id!==messageId)},scrollTarget:s.scrollTarget?.groupId===groupId&&s.scrollTarget.messageId===messageId?null:s.scrollTarget}))},
  handleReactionUpdate:(groupId,messageId,reactions)=>{const held=detachedWsMessages.get(groupId);if(held)detachedWsMessages.set(groupId,held.map(message=>message.id===messageId?{...message,reactions}:message));set((s)=>({messages:{...s.messages,[groupId]:(s.messages[groupId]??[]).map((m)=>m.id===messageId?{...m,reactions}:m)}}))},
}));

// Clear both owner changes and same-owner credential generations synchronously.
// The cache is stamped with the new scope but remains unavailable until refetched.
function resetGroupAuthScope(){
  const {ownerId, generation}=getAuthSessionSnapshot();
  const current=useGroupDMStore.getState();
  if(current.ownerId===ownerId&&current.authGeneration===generation)return;
  accountEpoch++;listRequest++;groupProjectionClock=0;groupProjectionVersions.clear();restoreRequest++;retiredSends.clear();readRequests.clear();historyRequests.clear();messageVersions.clear();messageCreateVersions.clear();groupLifetimes.clear();pendingCreates.clear();preparingSends.clear();recoverySendOrigins.clear();aroundPending.forEach(controller=>controller.abort());aroundPending.clear();aroundLoaded.clear();detachedWsMessages.clear();pendingAroundUpdates.clear();
  useComposerDraftStore.getState().reset();
  useGroupDMStore.setState({ownerId,authGeneration:generation,groups:[],messages:{},hasMoreAfterByGroup:{},scrollTarget:null,loading:false,error:null,uploadRecoveries:{},pendingSends:{},groupsReady:false,restoreStatus:"idle",restoreScope:null,restoreDeviceId:null,restoreBlocked:[],restoredQueue:{}});
}
resetGroupAuthScope();
subscribeAuthOwnerChanges(resetGroupAuthScope);
subscribeAuthGenerationChanges(resetGroupAuthScope);
