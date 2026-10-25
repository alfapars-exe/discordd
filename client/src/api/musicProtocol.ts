import {apiClient} from './client';
import {getAuthSessionSnapshot,subscribeAuthGenerationChanges,subscribeAuthOwnerChanges} from './authSessionEvents';
import {useVoiceStore} from '../stores/voiceStore';
import type {APIResponse,MusicBotChannelState} from '../types';

type Session={channel_id:string;server_id:string;session_id:string;revision:number;minimum_protocol:number};
export function captureMusicScope(serverId:string,channelId:string){
 const auth=getAuthSessionSnapshot(),voice=useVoiceStore.getState(),join=voice._joinGeneration,resetRevision=voice.musicBotResetRevision;
 const current=()=>{const now=getAuthSessionSnapshot(),v=useVoiceStore.getState();return !!auth.ownerId&&now.ownerId===auth.ownerId&&now.generation===auth.generation&&v.currentVoiceServerId===serverId&&v.currentVoiceChannelId===channelId&&v._joinGeneration===join&&v.musicBotResetRevision===resetRevision;};
 return {key:JSON.stringify([auth.ownerId,auth.generation,serverId,channelId,join,resetRevision]),current};
}
type Operation={path:string;method:'POST'|'PUT'|'DELETE';body:Record<string,unknown>;timeoutMs:number;scope:ReturnType<typeof captureMusicScope>;base:string;serverId:string;channelId:string};
const sessions=new Map<string,Session>(),pending=new Map<string,Operation>(),busy=new Set<string>();
const retryListeners=new Set<()=>void>();
const notifyRetries=()=>{for(const listener of retryListeners)listener();};
export function subscribeMusicRetries(listener:()=>void){retryListeners.add(listener);return ()=>{retryListeners.delete(listener);};}
const reset=()=>{sessions.clear();pending.clear();busy.clear();notifyRetries();};
subscribeAuthOwnerChanges(reset);subscribeAuthGenerationChanges(reset);
const failure=(code:string):APIResponse<never>=>({success:false,code,error:code});
export function hasPendingMusicMutation(serverId:string,channelId:string){return pending.has(captureMusicScope(serverId,channelId).key);}
const reads=new Map<string,number>();
export async function readMusicState(serverId:string,channelId:string,apply=false){
 const scope=captureMusicScope(serverId,channelId),sequence=(reads.get(scope.key)??0)+1;
 reads.set(scope.key,sequence);
 const before=useVoiceStore.getState().musicBotRevisions?.[channelId]??0;
 const response=await apiClient<MusicBotChannelState>(`/servers/${serverId}/channels/${channelId}/music/state`,{timeoutMs:15000,isCurrent:scope.current});
 if(!scope.current()||reads.get(scope.key)!==sequence)return failure("MUSIC_OBSOLETE");
 // Another HTTP read or accepted WS snapshot may have advanced this cache.
 if((useVoiceStore.getState().musicBotRevisions?.[channelId]??0)!==before)return failure("MUSIC_OBSOLETE");
 if(apply&&response.success&&response.data?.server_id===serverId&&response.data.channel_id===channelId){
  if(sessions.get(scope.key)?.session_id!==response.data.session_id)sessions.delete(scope.key);
  useVoiceStore.getState().setMusicBotState(channelId,response.data,true);
 }
 return response;
}
export function refreshMusicProtocolState(serverId:string,channelId:string){return readMusicState(serverId,channelId,true);}
async function execute<T>(op:Operation):Promise<APIResponse<T>>{
 if(!op.scope.current())return failure('MUSIC_OBSOLETE');
 busy.add(op.scope.key);
 try{
  const query=op.method==='DELETE'?'?'+new URLSearchParams(Object.entries(op.body).map(([k,v])=>[k,String(v)])).toString():'';
  let response:APIResponse<T>;
  try{response=await apiClient<T>(op.base+op.path+query,{method:op.method,body:op.method==='DELETE'?undefined:op.body,timeoutMs:op.timeoutMs,isCurrent:op.scope.current});}
  catch{response={success:false,isNetworkError:true};}
  if(!op.scope.current())return failure('MUSIC_OBSOLETE');
  if(response.isTimeout||response.isNetworkError){pending.set(op.scope.key,op);notifyRetries();return response;}
  pending.delete(op.scope.key);notifyRetries();
  if(response.status===409)sessions.delete(op.scope.key);
  if(response.success||response.status===409)await refreshMusicProtocolState(op.serverId,op.channelId);
  return op.scope.current()?response:failure("MUSIC_OBSOLETE");
 }finally{busy.delete(op.scope.key);}
}
export async function retryMusicMutation(serverId:string,channelId:string):Promise<APIResponse<unknown>>{
 const scope=captureMusicScope(serverId,channelId),op=pending.get(scope.key);
 if(!op||!scope.current())return failure('MUSIC_NO_RETRY');
 if(busy.has(scope.key))return failure('MUSIC_BUSY');
 return execute(op);
}
export async function mutateMusic<T>(serverId:string,channelId:string,path:string,method:'POST'|'PUT'|'DELETE',payload:Record<string,unknown>={},timeoutMs=15000,revision?:number,trackControl=false):Promise<APIResponse<T>>{
 const requestedState=useVoiceStore.getState().musicBotStates[channelId];
 const requestedRevision=revision??requestedState?.revision;
 const requestedTrack=requestedState?.current_track?.queue_item_id??'';
 const scope=captureMusicScope(serverId,channelId),base=`/servers/${serverId}/channels/${channelId}/music`;
 if(!scope.current())return failure('MUSIC_OBSOLETE');
 if(busy.has(scope.key))return failure('MUSIC_BUSY');
 if(pending.has(scope.key))return failure('MUSIC_RETRY_REQUIRED');
 busy.add(scope.key);
 try{
  let session=sessions.get(scope.key);
  if(session&&requestedState?.session_id&&session.session_id!==requestedState.session_id){sessions.delete(scope.key);session=undefined;}
  if(!session){
   const adopted=await apiClient<Session>(base+'/control-session',{method:'POST',body:{},timeoutMs:15000,isCurrent:scope.current});
   if(!scope.current())return failure('MUSIC_OBSOLETE');
   if(!adopted.success)return adopted.status===404||adopted.status===405?failure('MUSIC_PROTOCOL_REQUIRED'):adopted as APIResponse<T>;
   session=adopted.data;
   if(!session||session.minimum_protocol!==2||typeof session.session_id!=="string"||!session.session_id||!Number.isSafeInteger(session.revision)||session.revision<0||session.server_id!==serverId||session.channel_id!==channelId)return failure('MUSIC_PROTOCOL_REQUIRED');
   sessions.set(scope.key,session);
   if(useVoiceStore.getState().musicBotStates[channelId]?.session_id!==session.session_id)useVoiceStore.getState().clearMusicBotState(channelId);
   const fresh=await refreshMusicProtocolState(serverId,channelId);
   if(!scope.current())return failure('MUSIC_OBSOLETE');
   if(!fresh.success)return fresh as APIResponse<T>;
   if(!fresh.data||fresh.data.server_id!==serverId||fresh.data.channel_id!==channelId||fresh.data.session_id!==session.session_id)return failure("MUSIC_PROTOCOL_REQUIRED");
  }
  const state=useVoiceStore.getState().musicBotStates[channelId];
  if(typeof state?.session_id!=="string"||!state.session_id||state.session_id!==session.session_id||!Number.isSafeInteger(state.revision))return failure('MUSIC_PROTOCOL_REQUIRED');
  if(trackControl&&state.current_track&&!state.current_track.queue_item_id)return failure('MUSIC_PROTOCOL_REQUIRED');
  const body={...payload,session_id:state.session_id,request_id:crypto.randomUUID(),expected_revision:requestedRevision??state.revision,...(trackControl?{expected_queue_item_id:requestedState?requestedTrack:(state.current_track?.queue_item_id??'')}:{})};
  // Keep exact immutable payload and UUID for an explicitly requested retry.
  return await execute<T>({path,method,body,timeoutMs,scope,base,serverId,channelId});
 }finally{busy.delete(scope.key);}
}
