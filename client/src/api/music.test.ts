import {beforeEach,describe,expect,it,vi} from 'vitest';
vi.mock('./client',()=>({apiClient:vi.fn()}));
vi.mock('./musicProtocol',()=>({mutateMusic:vi.fn(),readMusicState:vi.fn(),captureMusicScope:()=>({current:()=>true}),retryMusicMutation:vi.fn(),hasPendingMusicMutation:vi.fn(),subscribeMusicRetries:vi.fn()}));
import {apiClient} from './client';
import {mutateMusic,readMusicState} from './musicProtocol';
import {getMusicState,pauseMusic,playMusic,removeMusicQueueItem,reorderMusicQueue,restoreMusicSession,resumeMusic,searchMusic,seekMusic,setMusicRepeatMode,shuffleMusicQueue,skipMusic,stopMusic} from './music';
beforeEach(()=>{vi.clearAllMocks();vi.mocked(apiClient).mockResolvedValue({success:true});vi.mocked(mutateMusic).mockResolvedValue({success:true});});
describe('music API protocol2 delegation and bounded reads',()=>{
 it.each([['skip',skipMusic,true],['pause',pauseMusic,true],['resume',resumeMusic,true],['stop',stopMusic,false]] as const)('delegates %s exclusively to guarded transport',async(action,request,track)=>{await request('s','c');expect(mutateMusic).toHaveBeenCalledExactlyOnceWith('s','c','/'+action,'POST',...(track?[{},15000,undefined,true]:[]));expect(apiClient).not.toHaveBeenCalled();});
 it('bounds state loading with live scope fence',async()=>{await getMusicState('s','c');expect(readMusicState).toHaveBeenCalledExactlyOnceWith('s','c');});
 it('retains longer extraction deadline inside guarded transport',async()=>{await playMusic('s','c','https://youtu.be/v');expect(mutateMusic).toHaveBeenCalledExactlyOnceWith('s','c','/play','POST',{url:'https://youtu.be/v'},50000);});
 it('encodes search and fences the bounded read',async()=>{await searchMusic('s','c','daft punk & friends');expect(apiClient).toHaveBeenCalledExactlyOnceWith('/servers/s/channels/c/music/search?q=daft%20punk%20%26%20friends',{timeoutMs:25000,isCurrent:expect.any(Function)});});
 it('preserves queue item IDs, caller revisions and action payloads',async()=>{await removeMusicQueueItem('s','c','item/id',4);expect(mutateMusic).toHaveBeenLastCalledWith('s','c','/queue/item%2Fid','DELETE',{},15000,4);await reorderMusicQueue('s','c',['b','a'],5);expect(mutateMusic).toHaveBeenLastCalledWith('s','c','/queue','PUT',{queue_item_ids:['b','a']},15000,5);await shuffleMusicQueue('s','c',6);expect(mutateMusic).toHaveBeenLastCalledWith('s','c','/shuffle','POST',{},15000,6);await setMusicRepeatMode('s','c','all');expect(mutateMusic).toHaveBeenLastCalledWith('s','c','/repeat','PUT',{mode:'all'});await restoreMusicSession('s','c');expect(mutateMusic).toHaveBeenLastCalledWith('s','c','/restore','POST');await seekMusic('s','c',42.9);expect(mutateMusic).toHaveBeenLastCalledWith('s','c','/seek','POST',{seconds:42},15000,undefined,true);});
});
