import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { playP2PAudio } from "./p2pPlayback";
class Track extends EventTarget { kind="audio"; readyState="live"; stop=vi.fn(); }
class Stream extends EventTarget {
  tracks:Track[]; constructor(tracks:Track[]=[]){super();this.tracks=[...tracks]}
  getAudioTracks(){return this.tracks.filter(track=>track.kind==="audio")}
  getTracks(){return this.tracks}
  addTrack(track:Track){this.tracks.push(track)}
  removeTrack(track:Track){this.tracks=this.tracks.filter(value=>value!==track)}
}
class Node {connect=vi.fn();disconnect=vi.fn()}
const audios:MockAudio[]=[],contexts:Context[]=[],configure:Array<(audio:MockAudio)=>void>=[];
class MockAudio extends EventTarget {
  autoplay=false;volume=1;muted=false;srcObject:unknown=null;onvolumechange:(()=>void)|null=null;
  setSinkId=vi.fn(async(_device:string)=>{});play=vi.fn(async()=>{});pause=vi.fn();
  constructor(){super();audios.push(this);configure.shift()?.(this)}
}
class Context {
  currentTime=0;state="running";destination=new Node();gain=Object.assign(new Node(),{gain:{setValueAtTime:vi.fn()}});
  output=new Stream([new Track()]);sourceNodes:Node[]=[];
  createGain=()=>this.gain;createMediaStreamDestination=()=>Object.assign(new Node(),{stream:this.output});
  createMediaStreamSource=vi.fn(()=>{const node=new Node();this.sourceNodes.push(node);return node});
  resume=vi.fn(async()=>{});close=vi.fn(async()=>{this.state="closed"});constructor(){contexts.push(this)}
}
const flush=async()=>{for(let i=0;i<15;i++)await Promise.resolve()};
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done});return{resolve,promise}};
const media=(stream=new Stream())=>stream as unknown as MediaStream;
const options=(extra:Partial<Parameters<typeof playP2PAudio>[1]>={})=>({outputDevice:"speaker",volume:1,isCurrent:()=>true,onFailure:vi.fn(),...extra});
beforeEach(()=>{audios.length=contexts.length=configure.length=0;vi.stubGlobal("Audio",MockAudio);vi.stubGlobal("AudioContext",Context);vi.stubGlobal("MediaStream",Stream)});
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers()});
it("routes both elements before play while only the processed owner follows gain/deafen",async()=>{
 const borrowed=new Track(),source=new Stream([borrowed]),opts=options({volume:0}),player=playP2PAudio(media(source),opts);
 await player.ready;const [audible,decoder]=audios;
 for(const element of audios){expect(element.setSinkId).toHaveBeenCalledWith("speaker");expect(element.setSinkId.mock.invocationCallOrder[0]).toBeLessThan(element.play.mock.invocationCallOrder[0])}
 expect(decoder.srcObject).toBeInstanceOf(Stream);expect(decoder.volume).toBe(0);expect(decoder.muted).toBe(false);expect(audible.muted).toBe(true);
 player.setVolume(1.5);expect(contexts[0].gain.gain.setValueAtTime).toHaveBeenLastCalledWith(1.5,0);expect(audible.volume).toBe(1);expect(decoder.volume).toBe(0);
 player.setVolume(0);expect(audible.muted).toBe(true);expect(decoder.volume).toBe(0);
 decoder.volume=1;decoder.onvolumechange?.();expect(decoder.volume).toBe(0);
 expect(contexts[0].gain.connect).not.toHaveBeenCalledWith(contexts[0].destination);expect(contexts[0].sourceNodes[0].connect).toHaveBeenCalledWith(contexts[0].gain);
 player.stop();for(const element of audios){expect(element.srcObject).toBeNull();expect(element.muted).toBe(true);expect(element.pause).toHaveBeenCalled()}
 expect(borrowed.stop).not.toHaveBeenCalled();expect(contexts[0].output.tracks[0].stop).toHaveBeenCalledOnce();expect(opts.onFailure).not.toHaveBeenCalled();
});
it("moves both elements to the same default only after an actual missing decoder sink",async()=>{
 configure.push(()=>{},audio=>audio.setSinkId.mockRejectedValueOnce(new DOMException("missing","NotFoundError")));
 const player=playP2PAudio(media(),options());expect(await player.ready).toEqual({fallback:true});
 for(const audio of audios)expect(audio.setSinkId.mock.calls.map(call=>call[0])).toEqual(["speaker",""]);
 expect(audios[1].volume).toBe(0);player.stop();
});
it.each(["NotAllowedError","NotSupportedError"])("does not play or fallback after decoder routing %s",async name=>{
 configure.push(()=>{},audio=>{if(name==="NotSupportedError")Object.defineProperty(audio,"setSinkId",{value:undefined});else audio.setSinkId.mockRejectedValue(new DOMException("denied",name))});
 const opts=options(),player=playP2PAudio(media(),opts);await expect(player.ready).rejects.toMatchObject({name});
 for(const audio of audios){expect(audio.play).not.toHaveBeenCalled();expect(audio.srcObject).toBeNull()}expect(opts.onFailure).toHaveBeenCalledOnce();
});
it("ignores an old decoder sink completion after account/device supersession",async()=>{
 const sink=deferred();configure.push(()=>{},audio=>audio.setSinkId.mockImplementationOnce(()=>sink.promise));let owner="old";
 const old=playP2PAudio(media(),options({isCurrent:()=>owner==="old"}));const settled=old.ready.catch(()=>{});await flush();owner="new";old.stop();
 const next=playP2PAudio(media(),options({outputDevice:"new",isCurrent:()=>owner==="new"}));await next.ready;sink.resolve();await settled;
 expect(audios[0].play).not.toHaveBeenCalled();expect(audios[1].play).not.toHaveBeenCalled();expect(audios[1].srcObject).toBeNull();
 expect(audios[2].setSinkId).toHaveBeenCalledWith("new");expect(audios[3].setSinkId).toHaveBeenCalledWith("new");next.stop();
});
it("cannot revive a zero-volume decoder whose play completes after stop",async()=>{
 const playing=deferred();configure.push(()=>{},audio=>audio.play.mockImplementationOnce(()=>playing.promise));let current=true;
 const opts=options({isCurrent:()=>current}),player=playP2PAudio(media(new Stream([new Track()])),opts);const settled=player.ready.catch(()=>{});await flush();expect(audios[1].play).toHaveBeenCalledOnce();
 current=false;player.stop();playing.resolve();await settled;await flush();expect(audios[1].volume).toBe(0);expect(audios[1].muted).toBe(true);expect(audios[1].srcObject).toBeNull();expect(audios[0].play).not.toHaveBeenCalled();expect(opts.onFailure).not.toHaveBeenCalled();
});
it("tracks borrowed audio additions/removals in the decoder without taking microphone/video ownership",async()=>{
 const first=new Track(),video=Object.assign(new Track(),{kind:"video"}),stream=new Stream([first,video]);const player=playP2PAudio(media(stream),options());await player.ready;
 const decoderStream=audios[1].srcObject as Stream;expect(decoderStream.getTracks()).toEqual([first]);const next=new Track();stream.addTrack(next);stream.dispatchEvent(new Event("addtrack"));expect(decoderStream.getTracks()).toEqual([first,next]);
 stream.removeTrack(first);stream.dispatchEvent(new Event("removetrack"));expect(decoderStream.getTracks()).toEqual([next]);expect(contexts[0].sourceNodes[0].disconnect).toHaveBeenCalledOnce();
 next.readyState="ended";next.dispatchEvent(new Event("ended"));expect(decoderStream.getTracks()).toEqual([]);player.stop();for(const track of [first,next,video])expect(track.stop).not.toHaveBeenCalled();
});
it("bounds a hung decoder route and surfaces failure without claiming playback",async()=>{
 vi.useFakeTimers();configure.push(()=>{},audio=>audio.setSinkId.mockImplementation(()=>new Promise(()=>{})));const opts=options(),player=playP2PAudio(media(),opts),rejected=expect(player.ready).rejects.toThrow("timed out");
 await vi.advanceTimersByTimeAsync(10_001);await rejected;expect(opts.onFailure).toHaveBeenCalledOnce();for(const audio of audios){expect(audio.play).not.toHaveBeenCalled();expect(audio.srcObject).toBeNull()}
});
it.each(["reject","still suspended"])("fails closed when context resume %s",async mode=>{
 class BlockedContext extends Context {constructor(){super();this.state="suspended";this.resume=vi.fn(async()=>{if(mode==="reject")throw new DOMException("blocked","NotAllowedError")})}}
 vi.stubGlobal("AudioContext",BlockedContext);const opts=options(),player=playP2PAudio(media(),opts);await expect(player.ready).rejects.toMatchObject({name:"NotAllowedError"});
 expect(audios[0].play).not.toHaveBeenCalled();expect(audios[1].volume).toBe(0);expect(audios[1].srcObject).toBeNull();expect(contexts[0].close).toHaveBeenCalled();expect(opts.onFailure).toHaveBeenCalledOnce();
});
it("cleans both owners after decoder autoplay or routed playback denial",async()=>{
 for(const decoderFailure of [true,false]){
  const begin=audios.length;configure.push(audio=>{if(!decoderFailure)audio.play.mockRejectedValue(new DOMException("blocked","NotAllowedError"))},audio=>{if(decoderFailure)audio.play.mockRejectedValue(new DOMException("blocked","NotAllowedError"))});
  const opts=options(),player=playP2PAudio(media(new Stream([new Track()])),opts);await expect(player.ready).rejects.toMatchObject({name:"NotAllowedError"});for(const audio of audios.slice(begin))expect(audio.srcObject).toBeNull();expect(opts.onFailure).toHaveBeenCalledOnce();
 }
});

it("never falls back a retired missing output over the replacement route",async()=>{
 let rejectOld!:(error:unknown)=>void;configure.push(audio=>audio.setSinkId.mockImplementationOnce(()=>new Promise<void>((_,reject)=>{rejectOld=reject})));let owner="old";
 const old=playP2PAudio(media(),options({isCurrent:()=>owner==="old"})),settled=old.ready.catch(()=>{});owner="new";old.stop();
 const next=playP2PAudio(media(),options({outputDevice:"new",isCurrent:()=>owner==="new"}));await next.ready;rejectOld(new DOMException("gone","NotFoundError"));await settled;
 expect(audios[0].setSinkId.mock.calls.map(call=>call[0])).toEqual(["speaker"]);expect(audios[1].setSinkId).not.toHaveBeenCalled();expect(audios[2].setSinkId).toHaveBeenCalledWith("new");expect(audios[3].setSinkId).toHaveBeenCalledWith("new");next.stop();
});
it("silences a routed play completion after its authenticated owner retires",async()=>{
 const playing=deferred();configure.push(audio=>audio.play.mockImplementationOnce(()=>playing.promise));let current=true;
 const opts=options({isCurrent:()=>current}),player=playP2PAudio(media(),opts),settled=player.ready.catch(()=>{});await flush();expect(audios[0].play).toHaveBeenCalledOnce();
 current=false;player.stop();playing.resolve();await settled;await flush();for(const audio of audios){expect(audio.muted).toBe(true);expect(audio.volume).toBe(0);expect(audio.srcObject).toBeNull()}expect(opts.onFailure).not.toHaveBeenCalled();
});

it("arms an empty/video-only stream and activates only live audio, including a later replacement",async()=>{
 const ended=Object.assign(new Track(),{readyState:"ended"}),video=Object.assign(new Track(),{kind:"video"}),source=new Stream([ended,video]);
 const player=playP2PAudio(media(source),options());await player.ready;const decoder=audios[1],derived=decoder.srcObject as Stream;
 expect(decoder.play).not.toHaveBeenCalled();expect(derived.getTracks()).toEqual([]);expect(contexts[0].sourceNodes).toHaveLength(0);
 const first=new Track();source.addTrack(first);source.dispatchEvent(new Event("addtrack"));await flush();expect(decoder.play).toHaveBeenCalledOnce();
 first.readyState="ended";first.dispatchEvent(new Event("ended"));expect(derived.getTracks()).toEqual([]);expect(decoder.pause).toHaveBeenCalledOnce();
 const second=new Track();source.addTrack(second);source.dispatchEvent(new Event("addtrack"));await flush();expect(decoder.play).toHaveBeenCalledTimes(2);expect(derived.getTracks()).toEqual([second]);expect(decoder.volume).toBe(0);player.stop();
 for(const track of [ended,video,first,second])expect(track.stop).not.toHaveBeenCalled();
});
it("cancels an obsolete activation without failing or pausing its newer live-track replacement",async()=>{
 let rejectOld!:(error:unknown)=>void;configure.push(()=>{},audio=>audio.play.mockImplementationOnce(()=>new Promise<void>((_,reject)=>{rejectOld=reject})));
 const source=new Stream(),opts=options(),player=playP2PAudio(media(source),opts);await player.ready;
 const old=new Track();source.addTrack(old);source.dispatchEvent(new Event("addtrack"));await flush();expect(audios[1].play).toHaveBeenCalledOnce();
 source.removeTrack(old);source.dispatchEvent(new Event("removetrack"));const next=new Track();source.addTrack(next);source.dispatchEvent(new Event("addtrack"));await flush();
 expect(audios[1].play).toHaveBeenCalledTimes(2);const pauses=audios[1].pause.mock.calls.length;rejectOld(new DOMException("late failure","NotAllowedError"));await flush();
 expect(audios[1].pause).toHaveBeenCalledTimes(pauses);expect(opts.onFailure).not.toHaveBeenCalled();expect((audios[1].srcObject as Stream).getTracks()).toEqual([next]);player.stop();
});
