import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {playP2PAudio} from './p2pPlayback';
class Track extends EventTarget{kind='audio';readyState='live';stop=vi.fn();}
class Stream extends EventTarget{readonly tracks:Track[];constructor(tracks:Track[]=[]){super();this.tracks=tracks;}getAudioTracks(){return this.tracks.filter(t=>t.kind==='audio');}getTracks(){return this.tracks;}}
class Node{connect=vi.fn();disconnect=vi.fn();}
const audios:MockAudio[]=[],contexts:Context[]=[];
class MockAudio extends EventTarget{
 autoplay=false;volume=1;muted=false;srcObject:unknown=null;
 setSinkId=vi.fn(async(_device:string)=>{});play=vi.fn(async()=>{});pause=vi.fn();
 constructor(){super();audios.push(this);}
}
class Context{
 currentTime=0;state='running';destination=new Node();gain=Object.assign(new Node(),{gain:{setValueAtTime:vi.fn()}});output=new Stream([new Track()]);sourceNodes:Node[]=[];
 createGain=()=>this.gain;createMediaStreamDestination=()=>Object.assign(new Node(),{stream:this.output});
 createMediaStreamSource=vi.fn(()=>{const node=new Node();this.sourceNodes.push(node);return node;});
 resume=vi.fn(async()=>{});close=vi.fn(async()=>{this.state='closed';});constructor(){contexts.push(this);}
}
const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
beforeEach(()=>{audios.length=contexts.length=0;vi.stubGlobal('Audio',MockAudio);vi.stubGlobal('AudioContext',Context);vi.stubGlobal('MediaStream',Stream);});
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();});
it('routes the sole element before play and applies zero or amplified remote gain without stopping borrowed tracks',async()=>{
 const track=new Track(),stream=new Stream([track]);const failure=vi.fn();const player=playP2PAudio(stream as unknown as MediaStream,{outputDevice:'speaker',volume:0,isCurrent:()=>true,onFailure:failure});
 await player.ready;expect(audios[0].setSinkId).toHaveBeenCalledWith('speaker');expect(audios[0].setSinkId.mock.invocationCallOrder[0]).toBeLessThan(audios[0].play.mock.invocationCallOrder[0]);
 expect(contexts[0].gain.gain.setValueAtTime).toHaveBeenLastCalledWith(0,0);expect(audios[0].muted).toBe(true);
 player.setVolume(1.5);expect(contexts[0].gain.gain.setValueAtTime).toHaveBeenLastCalledWith(1.5,0);expect(audios[0].volume).toBe(1);
 expect(contexts[0].gain.connect).not.toHaveBeenCalledWith(contexts[0].destination);expect(contexts[0].sourceNodes[0].connect).toHaveBeenCalledWith(contexts[0].gain);
 player.stop();expect(track.stop).not.toHaveBeenCalled();expect(contexts[0].output.tracks[0].stop).toHaveBeenCalledOnce();expect(audios[0].srcObject).toBeNull();expect(failure).not.toHaveBeenCalled();
});
it('falls back only for a missing output and refuses denied or unsupported custom routing',async()=>{
 class MissingAudio extends MockAudio{constructor(){super();this.setSinkId.mockRejectedValueOnce(new DOMException('gone','NotFoundError'));}}
 vi.stubGlobal('Audio',MissingAudio);const p=playP2PAudio(new Stream() as unknown as MediaStream,{outputDevice:'gone',volume:1,isCurrent:()=>true,onFailure:vi.fn()});expect(await p.ready).toEqual({fallback:true});expect(audios[0].setSinkId.mock.calls.map(c=>c[0])).toEqual(['gone','']);p.stop();
 class DeniedAudio extends MockAudio{constructor(){super();this.setSinkId.mockRejectedValueOnce(new DOMException('denied','NotAllowedError'));}}
 vi.stubGlobal('Audio',DeniedAudio);const failed=vi.fn();const denied=playP2PAudio(new Stream() as unknown as MediaStream,{outputDevice:'denied',volume:1,isCurrent:()=>true,onFailure:failed});await expect(denied.ready).rejects.toMatchObject({name:'NotAllowedError'});expect(audios[1].setSinkId).toHaveBeenCalledOnce();expect(audios[1].play).not.toHaveBeenCalled();expect(failed).toHaveBeenCalledOnce();
 class UnsupportedAudio extends MockAudio{constructor(){super();Object.defineProperty(this,'setSinkId',{value:undefined});}}
 vi.stubGlobal('Audio',UnsupportedAudio);const unsupported=playP2PAudio(new Stream() as unknown as MediaStream,{outputDevice:'custom',volume:1,isCurrent:()=>true,onFailure:vi.fn()});await expect(unsupported.ready).rejects.toMatchObject({name:'NotSupportedError'});expect(audios[2].play).not.toHaveBeenCalled();
});
it('prevents an obsolete pending sink or late play from reviving detached audio',async()=>{
 let finishSink!:()=>void;
 class SlowAudio extends MockAudio{constructor(){super();this.setSinkId.mockImplementationOnce(()=>new Promise<void>(resolve=>{finishSink=resolve;}));}}
 vi.stubGlobal('Audio',SlowAudio);let current=true;const failed=vi.fn();const player=playP2PAudio(new Stream() as unknown as MediaStream,{outputDevice:'old',volume:1,isCurrent:()=>current,onFailure:failed});
 current=false;player.stop();finishSink();await expect(player.ready).rejects.toMatchObject({name:'AbortError'});expect(audios[0].play).not.toHaveBeenCalled();expect(failed).not.toHaveBeenCalled();
 let finishPlay!:()=>void;class SlowPlay extends MockAudio{constructor(){super();this.play.mockImplementationOnce(()=>new Promise<void>(resolve=>{finishPlay=resolve;}));}}
 vi.stubGlobal('Audio',SlowPlay);current=true;const late=playP2PAudio(new Stream() as unknown as MediaStream,{outputDevice:'',volume:1,isCurrent:()=>current,onFailure:failed});await flush();current=false;late.stop();finishPlay();await expect(late.ready).rejects.toMatchObject({name:'AbortError'});await flush();expect(audios[1].muted).toBe(true);expect(audios[1].srcObject).toBeNull();
});
it('adds and removes remote audio tracks without touching microphone or video tracks',async()=>{
 const first=new Track(),video=Object.assign(new Track(),{kind:'video'}),stream=new Stream([first,video]);const p=playP2PAudio(stream as unknown as MediaStream,{outputDevice:'default',volume:1,isCurrent:()=>true,onFailure:vi.fn()});await p.ready;
 const next=new Track();stream.tracks.push(next);stream.dispatchEvent(new Event('addtrack'));expect(contexts[0].sourceNodes).toHaveLength(2);
 first.dispatchEvent(new Event('ended'));expect(contexts[0].sourceNodes[0].disconnect).toHaveBeenCalled();p.stop();expect(first.stop).not.toHaveBeenCalled();expect(next.stop).not.toHaveBeenCalled();expect(video.stop).not.toHaveBeenCalled();
});
it('bounds hung routing and surfaces playback/context failures rather than claiming success',async()=>{
 vi.useFakeTimers();class HungAudio extends MockAudio{constructor(){super();this.setSinkId.mockImplementationOnce(()=>new Promise(()=>{}));}}
 vi.stubGlobal('Audio',HungAudio);const failed=vi.fn();const p=playP2PAudio(new Stream() as unknown as MediaStream,{outputDevice:'hung',volume:1,isCurrent:()=>true,onFailure:failed});const rejection=expect(p.ready).rejects.toThrow('timed out');await vi.advanceTimersByTimeAsync(10000);await rejection;expect(failed).toHaveBeenCalledOnce();expect(audios[0].play).not.toHaveBeenCalled();
});

it.each(['context','play'])('surfaces %s permission failure with owned resource cleanup',async stage=>{
 class RejectedContext extends Context{constructor(){super();if(stage==='context')this.resume.mockRejectedValueOnce(new DOMException('blocked','NotAllowedError'));}}
 class RejectedAudio extends MockAudio{constructor(){super();if(stage==='play')this.play.mockRejectedValueOnce(new DOMException('blocked','NotAllowedError'));}}
 vi.stubGlobal('AudioContext',RejectedContext);vi.stubGlobal('Audio',RejectedAudio);const failed=vi.fn();const p=playP2PAudio(new Stream() as unknown as MediaStream,{outputDevice:'',volume:1,isCurrent:()=>true,onFailure:failed});await expect(p.ready).rejects.toMatchObject({name:'NotAllowedError'});expect(failed).toHaveBeenCalledOnce();expect(audios[0].srcObject).toBeNull();expect(contexts[0].close).toHaveBeenCalled();
});

it('a superseded missing sink cannot fallback over a newer independently routed output',async()=>{
 let rejectOld!:(error:unknown)=>void;
 class FirstSlow extends MockAudio{constructor(){super();if(audios.length===1)this.setSinkId.mockImplementationOnce(()=>new Promise<void>((_,reject)=>{rejectOld=reject;}));}}
 vi.stubGlobal('Audio',FirstSlow);let selected='old';const failed=vi.fn();const old=playP2PAudio(new Stream() as unknown as MediaStream,{outputDevice:'old',volume:1,isCurrent:()=>selected==='old',onFailure:failed});
 const oldSettled=old.ready.catch(()=>{});selected='new';old.stop();const next=playP2PAudio(new Stream() as unknown as MediaStream,{outputDevice:'new',volume:1,isCurrent:()=>selected==='new',onFailure:failed});await next.ready;
 rejectOld(new DOMException('gone','NotFoundError'));await oldSettled;await flush();expect(audios[0].setSinkId.mock.calls.map(c=>c[0])).toEqual(['old']);expect(audios[1].setSinkId).toHaveBeenCalledWith('new');expect(audios[1].srcObject).not.toBeNull();expect(failed).not.toHaveBeenCalled();next.stop();
});
