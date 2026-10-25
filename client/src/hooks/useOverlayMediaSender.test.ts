import {act,cleanup,renderHook,waitFor} from "@testing-library/react";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {setTokens} from "../api/client";
import {useAuthStore} from "../stores/authStore";
import {useVoiceStore} from "../stores/voiceStore";
const h=vi.hoisted(()=>({snapshot:{contexts:[],selected:null} as unknown,registryListeners:new Set<()=>void>(),make:vi.fn(),created:[] as Array<{options:{current:()=>boolean};dispose:ReturnType<typeof vi.fn>}>}));
vi.mock("../video/authorizedVideoSources",()=>({authorizedVideoSources:{getSnapshot:()=>h.snapshot,subscribe:(fn:()=>void)=>{h.registryListeners.add(fn);return()=>h.registryListeners.delete(fn)}}}));
vi.mock("../video/overlayMediaBridge",()=>({createOverlayMediaSender:h.make}));
import {useOverlayMediaSender} from "./useOverlayMediaSender";
let availability!:(value:unknown)=>void,media!:(value:unknown)=>void,viewport!:(value:unknown)=>void;
const native={openOverlayMediaLease:vi.fn(),sendOverlayMedia:vi.fn(),getOverlayMediaAvailability:vi.fn(),onOverlayMediaAvailability:vi.fn(),onOverlayMedia:vi.fn(),onOverlayMediaViewport:vi.fn()};
const available={ready:true,visible:true,allowedKinds:["camera","screen"],windowGeneration:"window-1"};
function source(kind:"camera"|"screen",tileId:string){return{tileId,kind,current:vi.fn(()=>true),subscribeScope:vi.fn(()=>()=>{}),track:{},addViewport:vi.fn(()=>({update:vi.fn(),release:vi.fn()}))};}
function publish(selected:unknown){h.snapshot={contexts:selected?[selected]:[],selected};h.registryListeners.forEach(fn=>fn());}
beforeEach(()=>{vi.clearAllMocks();h.registryListeners.clear();h.created=[];h.snapshot={contexts:[],selected:null};setTokens("qa-overlay","","owner");useAuthStore.setState({user:{id:"owner"}as never});useVoiceStore.setState({voiceOverlayEnabled:true,voiceOverlayVideo:true,voiceOverlayStreams:false});native.openOverlayMediaLease.mockResolvedValue(true);native.sendOverlayMedia.mockResolvedValue(true);native.getOverlayMediaAvailability.mockResolvedValue(available);native.onOverlayMediaAvailability.mockImplementation(fn=>{availability=fn;return()=>{}});native.onOverlayMedia.mockImplementation(fn=>{media=fn;return()=>{}});native.onOverlayMediaViewport.mockImplementation(fn=>{viewport=fn;return()=>{}});window.electronAPI=native as never;h.make.mockImplementation(options=>{const bridge={options,dispose:vi.fn(),start:vi.fn(async()=>true),receive:vi.fn(),ready:Promise.resolve(true)};h.created.push(bridge);return bridge});});
afterEach(()=>{cleanup();window.electronAPI=undefined;});
it("opens only authorized enabled kinds after native ready; speaking/label/array-only updates cannot churn lease",async()=>{
 const camera=source("camera","camera"),screen=source("screen","screen");publish({nonce:"call-1",label:"Current call",sources:[camera,screen]});const view=renderHook(()=>useOverlayMediaSender(true));await waitFor(()=>expect(h.make).toHaveBeenCalledOnce());expect(h.make.mock.calls[0][0].sources).toEqual([camera]);expect(native.openOverlayMediaLease.mock.calls[0][0].tiles).toEqual([{tileId:"camera",kind:"camera",label:"Current call"}]);act(()=>{publish({nonce:"call-1",label:"Renamed call",sources:[camera,screen]});availability({...available,allowedKinds:["screen","camera"]});useVoiceStore.setState({activeSpeakers:{peer:true}})});expect(h.make).toHaveBeenCalledOnce();expect(h.created[0].dispose).not.toHaveBeenCalled();
 act(()=>useVoiceStore.setState({voiceOverlayStreams:true}));await waitFor(()=>expect(h.make).toHaveBeenCalledTimes(2));expect(h.created[0].dispose).toHaveBeenCalled();expect(h.make.mock.calls[1][0].sources).toEqual([camera,screen]);view.unmount();expect(h.created[1].dispose).toHaveBeenCalled();void media;
});
it("late lease acknowledgement cannot clone retired auth or hidden windows",async()=>{
 let finish!:(value:boolean)=>void;native.openOverlayMediaLease.mockReturnValue(new Promise<boolean>(done=>{finish=done}));publish({nonce:"call-1",label:"Call",sources:[source("camera","cam")]});renderHook(()=>useOverlayMediaSender(true));await waitFor(()=>expect(native.openOverlayMediaLease).toHaveBeenCalledOnce());act(()=>availability({...available,visible:false}));await act(async()=>finish(true));expect(h.make).not.toHaveBeenCalled();
});
it("exact viewport enables only declared tile; hide/auth/source replacement retire current clone bridge",async()=>{
 const camera=source("camera","cam");publish({nonce:"call-1",label:"Call",sources:[camera]});renderHook(()=>useOverlayMediaSender(true));await waitFor(()=>expect(h.make).toHaveBeenCalledOnce());const lease=native.openOverlayMediaLease.mock.calls[0][0];act(()=>viewport({...lease,tileId:"other",visible:true,width:100,height:100,fps:30}));expect(camera.addViewport).not.toHaveBeenCalled();act(()=>viewport({...lease,tileId:"cam",visible:true,width:100,height:100,fps:30}));expect(camera.addViewport).toHaveBeenCalledWith({surface:"overlay",visible:true,width:100,height:100,fps:30});act(()=>setTokens("other-overlay","","other"));expect(h.created[0].dispose).toHaveBeenCalled();expect(h.created[0].options.current()).toBe(false);
});

it("a revoked source/current-key lease retires synchronously and a fresh source identity opens a replacement",async()=>{
 const old=source("camera","cam");publish({nonce:"call-1",label:"Call",sources:[old]});renderHook(()=>useOverlayMediaSender(true));await waitFor(()=>expect(h.make).toHaveBeenCalledOnce());old.current.mockReturnValue(false);act(()=>publish({nonce:"call-1",label:"Call",sources:[old]}));expect(h.created[0].dispose).toHaveBeenCalledOnce();expect(h.created[0].options.current()).toBe(false);const fresh=source("camera","cam");act(()=>publish({nonce:"call-2-key",label:"Call",sources:[fresh]}));await waitFor(()=>expect(h.make).toHaveBeenCalledTimes(2));expect(h.make.mock.calls[1][0].sources).toEqual([fresh]);
});
