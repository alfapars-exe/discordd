import {beforeEach,describe,expect,it,vi} from "vitest";
const h=vi.hoisted(()=>({state:{outputDevice:"speaker",masterVolume:50,userVolumes:{peer:150},screenShareVolumes:{peer:80},localMutedUsers:{} as Record<string,boolean>,isDeafened:false,isServerDeafened:true},listeners:new Set<()=>void>(),players:[] as Array<{options:{outputDevice:string;volume:number;isCurrent:()=>boolean;onFailure:()=>void};stop:ReturnType<typeof vi.fn>;setVolume:ReturnType<typeof vi.fn>}>,play:vi.fn()}));
vi.mock("../stores/voiceStore",()=>({useVoiceStore:{getState:()=>h.state,subscribe:(callback:()=>void)=>{h.listeners.add(callback);return()=>h.listeners.delete(callback);}}}));
vi.mock("./privatePlayback",()=>({playPrivateAudio:h.play}));
import {RoomEvent,Track,type Room}from "livekit-client";
import {privateRoomPlayback}from "./privateRoomPlayback";
import {publishAuthOwnerChange,publishAuthGenerationChange}from "../api/authSessionEvents";
function fixture(){const events=new Map<string,Set<(...args:unknown[])=>void>>();const media={readyState:"live",stop:vi.fn()};const track={kind:Track.Kind.Audio,mediaStreamTrack:media};const publication={trackSid:"sid",track,source:Track.Source.Microphone};const peer={identity:"peer",trackPublications:new Map([["sid",publication]])};const room={remoteParticipants:new Map([["peer",peer]]),on:(key:string,fn:(...args:unknown[])=>void)=>{const set=events.get(key)??new Set();set.add(fn);events.set(key,set);},off:(key:string,fn:(...args:unknown[])=>void)=>events.get(key)?.delete(fn)};return{room:room as unknown as Room,peer,publication,track,media,emit:(key:string,...args:unknown[])=>events.get(key)?.forEach(fn=>fn(...args))};}
beforeEach(()=>{publishAuthOwnerChange("owner");publishAuthGenerationChange(1);h.listeners.clear();h.players=[];Object.assign(h.state,{outputDevice:"speaker",masterVolume:50,userVolumes:{peer:150},screenShareVolumes:{peer:80},localMutedUsers:{},isDeafened:false,isServerDeafened:true});vi.stubGlobal("MediaStream",class{constructor(_tracks:unknown[]){}});h.play.mockReset().mockImplementation((_stream,options)=>{const player={options,stop:vi.fn(),setVolume:vi.fn(),ready:Promise.resolve({fallback:false})};h.players.push(player);return player;});});
const update=()=>h.listeners.forEach(fn=>fn());
describe("private room playback ownership",()=>{
 it("uses selected output and master times per-person gain, ignoring guild deafen but respecting private local mute/deafen",()=>{
  const f=fixture();const stop=privateRoomPlayback(f.room,vi.fn());expect(h.players[0].options).toMatchObject({outputDevice:"speaker",volume:0.75});
  h.state.localMutedUsers={peer:true};update();expect(h.players[0].setVolume).toHaveBeenLastCalledWith(0);
  h.state.localMutedUsers={};h.state.isDeafened=true;update();expect(h.players[0].setVolume).toHaveBeenLastCalledWith(0);stop();expect(f.media.stop).not.toHaveBeenCalled();
 });
 it("replaces only owned graphs on output change, fences old completions and never stops borrowed remote tracks",()=>{
  const f=fixture();const stop=privateRoomPlayback(f.room,vi.fn());const first=h.players[0];expect(first.options.isCurrent()).toBe(true);
  h.state.outputDevice="new-speaker";update();expect(first.stop).toHaveBeenCalledOnce();expect(first.options.isCurrent()).toBe(false);expect(h.players[1].options.outputDevice).toBe("new-speaker");
  f.emit(RoomEvent.TrackUnsubscribed,f.track);expect(h.players[1].stop).toHaveBeenCalledOnce();stop();expect(f.media.stop).not.toHaveBeenCalled();
 });
 it("closes retained output immediately at account generation replacement",()=>{
  const f=fixture();const stop=privateRoomPlayback(f.room,vi.fn());publishAuthGenerationChange(2);expect(h.players[0].stop).toHaveBeenCalledOnce();expect(h.players[0].options.isCurrent()).toBe(false);stop();
 });
 it("rejects late disconnected participant tracks without touching a replacement participant",()=>{
  const f=fixture();const stop=privateRoomPlayback(f.room,vi.fn());const first=h.players[0];
  const replacement={...f.peer,trackPublications:new Map()};f.room.remoteParticipants.set("peer",replacement as never);
  expect(first.options.isCurrent()).toBe(false);f.emit(RoomEvent.TrackSubscribed,f.track,f.publication,f.peer);expect(h.players).toHaveLength(1);
  const nextTrack={kind:Track.Kind.Audio,mediaStreamTrack:{readyState:"live",stop:vi.fn()}};const nextPub={trackSid:"new",track:nextTrack,source:Track.Source.Microphone};replacement.trackPublications.set("new",nextPub);
  f.emit(RoomEvent.TrackSubscribed,nextTrack,nextPub,replacement);expect(h.players).toHaveLength(2);
  f.emit(RoomEvent.ParticipantDisconnected,f.peer);expect(first.stop).toHaveBeenCalledOnce();expect(h.players[1].stop).not.toHaveBeenCalled();stop();
 });

});
