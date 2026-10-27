import {act,render,screen,waitFor}from "@testing-library/react";
import {StrictMode}from "react";
import {beforeAll,beforeEach,expect,it,vi}from "vitest";
const h=vi.hoisted(()=>({rooms:[] as {connect:ReturnType<typeof vi.fn>;disconnect:ReturnType<typeof vi.fn>}[],list:vi.fn(),token:vi.fn()}));
vi.mock("../../api/groupDM",()=>({listGroupDMs:h.list,getGroupDMCallToken:h.token}));
vi.mock("../../audio/voiceEncryptionKeys",()=>({IndexedVoiceKeyProvider:class{setIndexedKey=vi.fn(async()=>true)},isMediaKeyVersion:(i:number,e:number)=>Number.isSafeInteger(e)&&i===e%256,mediaTokenSubject:(token:string)=>{try{return JSON.parse(atob(token.split('.')[1])).sub}catch{return null}}}));
vi.mock("livekit-client",async original=>{
 const actual=await original<typeof import("livekit-client")>();
 return {...actual,isE2EESupported:()=>true,Room:class{
 localParticipant={identity:"",isLocal:true,getTrackPublications:()=>[],getTrackPublication:()=>undefined,trackPublications:new Map(),createTracks:vi.fn(async()=>[]),createScreenTracks:vi.fn(async()=>[]),publishTrack:vi.fn(async(track:unknown)=>({track})),unpublishTrack:vi.fn(async()=>{}),setMicrophoneEnabled:vi.fn(async()=>{}),setCameraEnabled:vi.fn(async()=>{}),setScreenShareEnabled:vi.fn(async()=>{})};
 state="disconnected";listeners=new Map<string,Set<(...args:unknown[])=>void>>();remoteParticipants=new Map();
 constructor(){h.rooms.push(this)}
 on(event:string,handler:(...args:unknown[])=>void){const listeners=this.listeners.get(event)??new Set();listeners.add(handler);this.listeners.set(event,listeners);return this}
 off(event:string,handler:(...args:unknown[])=>void){this.listeners.get(event)?.delete(handler);return this}
 emit(event:string,...args:unknown[]){this.listeners.get(event)?.forEach(fn=>fn(...args))}
 setE2EEEnabled=vi.fn(async()=>{});
 connect=vi.fn(async()=>{this.state="connected";this.localParticipant.identity="me";this.emit(actual.RoomEvent.Connected);this.emit(actual.RoomEvent.SignalConnected)});
 disconnect=vi.fn(async()=>{this.state="disconnected";this.emit(actual.RoomEvent.Disconnected)});
 }};
});
vi.mock("@livekit/components-react",async original=>({...await original<typeof import("@livekit/components-react")>(),TrackToggle:()=>null,DisconnectButton:()=>null}));
vi.mock("./GroupDMCallAudio",()=>({default:()=> <div data-testid="admitted-audio"/>}));
vi.mock("../../api/clientLog",()=>({logToServer:vi.fn()}));
vi.mock("../../monitoring/sentry",()=>({captureBoundaryError:vi.fn()}));
import GroupCallProvider from "./GroupCallProvider";
import {useGroupCallStore}from "../../stores/groupCallStore";
import {useGroupDMStore}from "../../stores/groupDMStore";
import {useAuthStore}from "../../stores/authStore";
import {useE2EEStore}from "../../stores/e2eeStore";
import {getAuthGeneration,setTokens}from "../../api/client";
import {publishAuthOwnerChange}from "../../api/authSessionEvents";
import {RoomEvent}from "livekit-client";
const group={id:"group",owner_id:"me",name:"Group",members:[{id:"me",username:"me",display_name:null,avatar_url:null,custom_status:null,status:"online" as const,created_at:"2026-01-01"}],icon_url:null,key_epoch:1,call_room_key:"room",unread_count:0,created_at:"2026-01-01",updated_at:"2026-01-01"};
// Exercise admission and navigation with the real SDK module already loaded.
// Cold module transformation under full-suite load is not admission latency.
beforeAll(async()=>{await import("./GroupDMCall");});
beforeEach(()=>{
 const old=useGroupCallStore.getState().session;if(old)useGroupCallStore.getState().leave(old.nonce);h.rooms=[];h.list.mockReset().mockResolvedValue({success:true,data:{group_dms:[group]}});h.token.mockReset().mockResolvedValue({success:true,data:{token:`header.${btoa(JSON.stringify({sub:'me'}))}.signature`,channel_id:"group",url:"wss://voice.test",e2ee_passphrase:"pass",e2ee_key_context:"context",e2ee_key_epoch:1,e2ee_key_index:1}});
 setTokens("access","refresh");useAuthStore.setState({user:{id:"me"} as never});publishAuthOwnerChange("me");useE2EEStore.setState({initStatus:"ready",localDeviceId:"device"});useGroupDMStore.setState({ownerId:"me",authGeneration:getAuthGeneration(),groupsReady:true,groups:[group]});
 // Match EventTarget event routing: normal worker message ACKs must never
 // invoke error/messageerror listeners installed by the key provider.
 vi.stubGlobal("Worker",class extends EventTarget{
  terminate=vi.fn();
  postMessage(data:unknown){queueMicrotask(()=>this.dispatchEvent(new MessageEvent("message",{data})));}
 });
});
it.each([false,true])("keeps real admission/installed SDK room stable through parent navigation rerenders (strict=%s)",async strict=>{
 const body=(route:string)=><><section>{route}</section><GroupCallProvider/></>;
 const view=render(strict?<StrictMode>{body('group')}</StrictMode>:body('group'));
 act(()=>{expect(useGroupCallStore.getState().join("group")).toBe(true)});await screen.findByTestId("admitted-audio");
 const sessions=h.rooms.reduce((sum,room)=>sum+room.connect.mock.calls.length,0);const rooms=h.rooms.length;
 for(let i=0;i<4;i++){view.rerender(strict?<StrictMode>{body('friends'+i)}</StrictMode>:body('friends'+i));await waitFor(()=>expect(screen.getByTestId("admitted-audio")).toBeInTheDocument())}
 expect(h.rooms).toHaveLength(rooms);expect(h.rooms.reduce((sum,room)=>sum+room.connect.mock.calls.length,0)).toBe(sessions);expect(h.token).toHaveBeenCalledTimes(1);
 vi.useFakeTimers();try{await act(async()=>vi.advanceTimersByTimeAsync(45_000));expect(h.rooms).toHaveLength(rooms);expect(h.rooms.reduce((sum,room)=>sum+room.connect.mock.calls.length,0)).toBe(sessions);expect(h.token).toHaveBeenCalledTimes(1)}finally{vi.useRealTimers()}
 view.unmount();const source=useGroupCallStore.getState().session;if(source)useGroupCallStore.getState().leave(source.nonce);
});
it("keeps the group call bound across navigation during an SDK reconnect",async()=>{
 const body=(route:string)=><><section>{route}</section><GroupCallProvider/></>;
 const view=render(body("group"));
 act(()=>{expect(useGroupCallStore.getState().join("group")).toBe(true)});
 await screen.findByTestId("admitted-audio");
 const session=useGroupCallStore.getState().session;
 const room=h.rooms.at(-1) as typeof h.rooms[number] & {state:string;emit:(event:string)=>void};
 const connections=room.connect.mock.calls.length;
 act(()=>{room.state="reconnecting";room.emit(RoomEvent.Reconnecting)});
 view.rerender(body("friends"));
 expect(useGroupCallStore.getState().session).toEqual(session);
 act(()=>{room.state="connected";room.emit(RoomEvent.Reconnected)});
 await waitFor(()=>expect(screen.getByTestId("admitted-audio")).toBeInTheDocument());
 expect(useGroupCallStore.getState().session).toEqual(session);
 expect(room.connect).toHaveBeenCalledTimes(connections);
 expect(h.token).toHaveBeenCalledTimes(1);
 view.unmount();
 if(session)useGroupCallStore.getState().leave(session.nonce);
});
