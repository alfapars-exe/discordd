import {getAuthSessionSnapshot,subscribeAuthGenerationChanges,subscribeAuthOwnerChanges} from '../api/authSessionEvents';
import {useAuthStore} from '../stores/authStore';
import {HOME_DESTINATION,useUIStore,type Destination} from '../stores/uiStore';
import {useDMStore} from '../stores/dmStore';
import {useGroupDMStore} from '../stores/groupDMStore';
import {useServerStore} from '../stores/serverStore';
import {useChannelStore} from '../stores/channelStore';
import {useMemberStore} from '../stores/memberStore';
import {useChannelPermissionStore} from '../stores/channelPermissionStore';
import {useThreadStore} from '../stores/threadStore';
import {useP2PCallStore} from '../stores/p2pCallStore';
import {Permissions,resolveChannelPermissions} from './permissions';
import {resolveChatChannel} from './resolveChatChannel';
import i18n from '../i18n';

type ReturnPoint={ownerId:string;generation:number;destination:Destination};
// Navigation metadata only, never drafts, File objects, tabs or persistent storage.
let returnPoint:ReturnPoint|null=null;
const clear=()=>{returnPoint=null;};
subscribeAuthOwnerChanges(clear);subscribeAuthGenerationChanges(clear);

/** Resolve labels and access from the current account's already-loaded stores.
 * This fails closed on cold/revoked caches; the destination's normal server
 * authorization remains authoritative. No fetch, join, leave or draft clearing. */
function resolveReturn(point:ReturnPoint):Destination|null{
 const target=point.destination,{ownerId,generation}=point;
 if(target.type==='friends'||target.type==='notifications'||target.type==='saved')return {...target,label:''};
 if(target.type==='dm'){
  const state=useDMStore.getState();
  if(state.ownerId!==ownerId||state.authGeneration!==generation||state.isLoading)return null;
  const channel=state.channels.find(item=>item.id===target.channelId);
  if(!channel?.other_user||!['accepted','pending'].includes(channel.status))return null;
  return {type:'dm',channelId:channel.id,label:channel.other_user.display_name||channel.other_user.username};
 }
 if(target.type==='group-dm'){
  const state=useGroupDMStore.getState();
  if(state.ownerId!==ownerId||state.authGeneration!==generation||!state.groupsReady)return null;
  const group=state.groups.find(item=>item.id===target.channelId);
  return group&&Array.isArray(group.members)&&group.members.some(member=>member.id===ownerId)?{type:'group-dm',channelId:group.id,label:group.name}:null;
 }
 if(target.type==='p2p'){
  const call=useP2PCallStore.getState().activeCall;
  return call?.id===target.channelId&&(call.caller_id===ownerId||call.receiver_id===ownerId)?{...target}:null;
 }
 const serverId=target.serverInfo?.serverId;
 if(!serverId)return null;
 const server=useServerStore.getState().servers.find(item=>item.id===serverId);
 const members=useMemberStore.getState();
 if(!server||members.ownerId!==ownerId||members.authGeneration!==generation||members.statusByServer[serverId]!=='ready'||members.loadingServers.has(serverId))return null;
 const member=members.membersByServer[serverId]?.find(item=>item.id===ownerId);
 if(!member||!Array.isArray(member.roles))return null;
 const serverInfo={serverId,serverName:server.name,serverIconUrl:server.icon_url};
 if(target.type==='server-home')return {type:'server-home',channelId:serverId,label:server.name,serverInfo};
 const resolved=resolveChatChannel(target.channelId,serverId,{categoriesByServer:useChannelStore.getState().categoriesByServer,threads:useThreadStore.getState(),currentOwnerId:ownerId,currentAuthGeneration:generation});
 if(!resolved)return null;
 const {channel,permissionChannelId}=resolved;
 const matches=target.type==='text'?channel.type==='text'||channel.type==='thread':channel.type===(target.type==='screen'?'voice':target.type);
 if(!matches)return null;
 const overrides=useChannelPermissionStore.getState(),load=overrides.statusByChannel[permissionChannelId];
 if(load?.status!=='ready'||load.ownerId!==ownerId||load.authGeneration!==generation||load.serverId!==serverId||!Array.isArray(overrides.overridesByChannel[permissionChannelId]))return null;
 const permissions=resolveChannelPermissions(member.effective_permissions??0,member.roles.map(role=>role.id),overrides.overridesByChannel[permissionChannelId]);
 const required=Permissions.ViewChannel|((target.type==='voice'||target.type==='screen')?Permissions.ConnectVoice:Permissions.ReadMessages);
 if(!(permissions&Permissions.Admin)&&(permissions&required)!==required)return null;
 return {...target,label:channel.name,serverInfo};
}
export function toggleInboxShortcut():void{
 const session=getAuthSessionSnapshot(),ownerId=useAuthStore.getState().user?.id;
 if(!ownerId||session.ownerId!==ownerId){clear();return;}
 const ui=useUIStore.getState();
 if(ui.destination.type!=='inbox'){
  returnPoint={ownerId,generation:session.generation,destination:{...ui.destination,serverInfo:ui.destination.serverInfo?{...ui.destination.serverInfo}:undefined}};
  ui.navigate({type:'inbox',channelId:'inbox',label:i18n.t('common:shellInbox')});
  return;
 }
 const saved=returnPoint;clear();
 const target=saved?.ownerId===ownerId&&saved.generation===session.generation?resolveReturn(saved):null;
 ui.navigate(target??HOME_DESTINATION);
}
