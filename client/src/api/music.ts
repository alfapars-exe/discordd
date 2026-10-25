import {apiClient} from './client';
import {captureMusicScope,mutateMusic,readMusicState} from './musicProtocol';
import type {PlayMusicResponse,SearchMusicResponse} from '../types';
export {retryMusicMutation,hasPendingMusicMutation,subscribeMusicRetries} from './musicProtocol';
export const playMusic=(s:string,c:string,url:string)=>mutateMusic<PlayMusicResponse>(s,c,'/play','POST',{url},50000);
export function searchMusic(s:string,c:string,query:string){const scope=captureMusicScope(s,c);return apiClient<SearchMusicResponse>(`/servers/${s}/channels/${c}/music/search?q=${encodeURIComponent(query)}`,{timeoutMs:25000,isCurrent:scope.current});}
export const skipMusic=(s:string,c:string)=>mutateMusic<{status:string}>(s,c,'/skip','POST',{},15000,undefined,true);
export const pauseMusic=(s:string,c:string)=>mutateMusic<{status:string}>(s,c,'/pause','POST',{},15000,undefined,true);
export const resumeMusic=(s:string,c:string)=>mutateMusic<{status:string}>(s,c,'/resume','POST',{},15000,undefined,true);
export const stopMusic=(s:string,c:string)=>mutateMusic<{status:string}>(s,c,'/stop','POST');
export const getMusicState=readMusicState;
export const removeMusicQueueItem=(s:string,c:string,id:string,revision:number)=>mutateMusic<{status:string}>(s,c,`/queue/${encodeURIComponent(id)}`,'DELETE',{},15000,revision);
export const reorderMusicQueue=(s:string,c:string,ids:string[],revision:number)=>mutateMusic<{status:string}>(s,c,'/queue','PUT',{queue_item_ids:[...ids]},15000,revision);
export const shuffleMusicQueue=(s:string,c:string,revision:number)=>mutateMusic<{status:string}>(s,c,'/shuffle','POST',{},15000,revision);
export const setMusicRepeatMode=(s:string,c:string,mode:'off'|'one'|'all')=>mutateMusic<{status:string}>(s,c,'/repeat','PUT',{mode});
export const seekMusic=(s:string,c:string,seconds:number)=>mutateMusic<{status:string}>(s,c,'/seek','POST',{seconds:Math.floor(seconds)},15000,undefined,true);
export const restoreMusicSession=(s:string,c:string)=>mutateMusic<{status:string}>(s,c,'/restore','POST');
