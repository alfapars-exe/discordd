import {useAuthStore} from '../stores/authStore';
import {useFriendStore} from '../stores/friendStore';
import {usePreferencesStore} from '../stores/preferencesStore';
import {useSpamDecisionStore} from '../stores/spamDecisionStore';
import {getAuthGeneration} from '../api/client';
import {subscribeAuthGenerationChanges,subscribeAuthOwnerChanges} from '../api/authSessionEvents';
import {classifySpam} from './spamClassification';
export type SpamCandidate={id:string;user_id:string;content:string|null;edited_at?:string|null};
export type SpamKind='channel'|'dm'|'group';
export type SpamDisposition='allow'|'filter'|'pending';
export function getMessageSpamDisposition(message:SpamCandidate,kind?:SpamKind):SpamDisposition{
 const owner=useAuthStore.getState().user?.id;
 const decisions=useSpamDecisionStore.getState(),decision=decisions.decisions[`${kind}:${message.id}`],revision=message.edited_at??'original';
 if(decisions.accountId===owner&&decision?.revision===revision&&decision.status==='restored')return 'allow';
 const privacy=usePreferencesStore.getState().get<{spamFilter?:'all'|'nonfriends'|'off';spamRestoredMessages?:Record<string,string>}>('privacy');
 const mode=privacy?.spamFilter??'nonfriends';
 if(message.user_id===owner||mode==='off'||privacy?.spamRestoredMessages?.[message.id]===revision)return 'allow';
 const result=classifySpam(message.content);
 if(result.status!=='classified'||!result.spam)return 'allow';
 if(mode==='all')return 'filter';
 const friends=useFriendStore.getState();
 if(!owner||friends.ownerId!==owner||friends.authGeneration!==getAuthGeneration()||friends.friendsStatus!=='ready')return 'pending';
 return friends.friends.some(friend=>friend.user_id===message.user_id)?'allow':'filter';
}
export function isMessageFilteredAsSpam(message:SpamCandidate,kind?:SpamKind):boolean{return getMessageSpamDisposition(message,kind)==='filter';}
export function shouldSuppressMessagePreview(message:SpamCandidate,kind?:SpamKind):boolean{return getMessageSpamDisposition(message,kind)!=='allow';}

type Readiness='ready'|'pending'|'stale';
const reads=new Map<string,{promise:Promise<Readiness>;failed:boolean}>();
const clear=()=>reads.clear();subscribeAuthOwnerChanges(clear);subscribeAuthGenerationChanges(clear);
/** A failed snapshot stays pending until explicit retry or a canonical WS read;
 * bursts of incoming messages cannot create an unbounded friend-fetch loop. */
export async function ensureSpamRelationshipReady(isCurrent:()=>boolean=()=>true,retry=false):Promise<Readiness>{
 const owner=useAuthStore.getState().user?.id,generation=getAuthGeneration();
 const accountCurrent=()=>!!owner&&useAuthStore.getState().user?.id===owner&&getAuthGeneration()===generation;
 const ready=()=>{const state=useFriendStore.getState();return accountCurrent()&&state.ownerId===owner&&state.authGeneration===generation&&state.friendsStatus==='ready';};
 if(!accountCurrent()||!isCurrent())return 'stale';
 if(ready())return 'ready';
 const key=JSON.stringify([owner,generation]),state=useFriendStore.getState(),existing=reads.get(key);
 if(existing&&(!existing.failed||(!retry&&state.friendsStatus!=='loading'))){const result=await existing.promise;return accountCurrent()&&isCurrent()?result:'stale';}
 let failed=false;
 const promise=new Promise<Readiness>(resolve=>{
  let settled=false,starting=true;
  const finish=(result:Readiness)=>{if(settled)return;settled=true;failed=result==='pending';clearTimeout(timer);unsubscribe();resolve(result);};
  const inspect=()=>{if(starting)return;if(!accountCurrent()){finish('stale');return;}if(ready()){finish('ready');return;}const next=useFriendStore.getState();if(next.ownerId===owner&&next.authGeneration===generation&&next.friendsStatus==='error')finish('pending');};
  const timer=setTimeout(()=>finish(accountCurrent()?'pending':'stale'),15000);
  const unsubscribe=useFriendStore.subscribe(inspect);
  const currentState=useFriendStore.getState();
  if(currentState.ownerId!==owner||currentState.authGeneration!==generation||currentState.friendsStatus!=='loading')void currentState.fetchFriends().then(()=>{starting=false;inspect();if(!settled)finish(ready()?'ready':'pending');},()=>{starting=false;finish('pending');});
  starting=false;inspect();
 });
 const entry={promise,failed:false};reads.set(key,entry);
 void promise.then(result=>{entry.failed=failed;if(result!=='pending'&&reads.get(key)===entry)reads.delete(key);});
 const result=await promise;return accountCurrent()&&isCurrent()?result:'stale';
}
export async function resolveMessageSpamDisposition(message:SpamCandidate,kind:SpamKind,isCurrent:()=>boolean=()=>true):Promise<SpamDisposition|'stale'>{
 if(!isCurrent())return 'stale';
 if(getMessageSpamDisposition(message,kind)==='pending'&&await ensureSpamRelationshipReady(isCurrent)==='stale')return 'stale';
 return isCurrent()?getMessageSpamDisposition(message,kind):'stale';
}
