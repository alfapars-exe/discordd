import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

import { useVoice } from "./useVoice";
import { useVoiceStore } from "../stores/voiceStore";
import {useP2PCallStore} from "../stores/p2pCallStore";
import {bindGroupCallAudioControl,releaseGroupCallAudioControl,toggleGroupCallMicrophone,useGroupCallAudioControlStore}from "../stores/groupCallAudioControlStore";
import {publishAuthOwnerChange,publishAuthGenerationChange}from "../api/authSessionEvents";

vi.mock("../api/voice", () => ({ getVoiceToken: vi.fn() }));
vi.mock("../api/client", () => ({ ensureFreshToken: vi.fn(), getAuthGeneration: () => 1 }));
vi.mock("../utils/sounds", () => ({
  playJoinSound: vi.fn(),
  playLeaveSound: vi.fn(),
  closeAudioContext: vi.fn(),
}));
vi.mock("../stores/preferencesStore", () => ({
  usePreferencesStore: { getState: () => ({ set: vi.fn() }) },
}));
vi.mock("../stores/serverStore", () => ({
  useServerStore: { getState: () => ({ activeServerId: "srv1" }) },
}));
vi.mock("../i18n", () => ({ default: { t: (k: string) => k } }));
vi.mock("../stores/toastStore", () => ({
  useToastStore: { getState: () => ({ addToast: vi.fn() }) },
}));

function resetStore() {
  useVoiceStore.setState({
    currentVoiceChannelId: null,
    currentVoiceServerId: null,
    livekitUrl: null,
    livekitToken: null,
    isServerMuted: false,
    isServerDeafened: false,
    isMuted: false,
    isDeafened: false,
    isStreaming: false,
    _wsSend: null,
  });
}

/** Renders the hook with fresh spies for the three WS-send callbacks. */
function renderVoice() {
  const sendVoiceJoin = vi.fn();
  const sendVoiceLeave = vi.fn();
  const sendVoiceStateUpdate = vi.fn();
  const utils = renderHook(() =>
    useVoice({ sendVoiceJoin, sendVoiceLeave, sendVoiceStateUpdate }),
  );
  return { ...utils, sendVoiceJoin, sendVoiceLeave, sendVoiceStateUpdate };
}


const binding=(nonce:string,toggle=vi.fn())=>({nonce,accountId:"me",generation:1,groupId:"group",manualMuted:false,effectiveMuted:false,blocked:false,toggle});
beforeEach(()=>{resetStore();publishAuthOwnerChange("me");publishAuthGenerationChange(1);useP2PCallStore.setState({activeCall:null});useGroupCallAudioControlStore.setState({control:null});});
describe("owner-bound group manual mute commands",()=>{
 it("routes the real shared shortcut command to its exact current group without guild WS updates",()=>{
  const group=binding("call-a");bindGroupCallAudioControl(group);const view=renderVoice();act(()=>view.result.current.toggleMute());expect(group.toggle).toHaveBeenCalledOnce();expect(view.sendVoiceStateUpdate).not.toHaveBeenCalled();expect(useVoiceStore.getState().isMuted).toBe(false);view.unmount();
 });
 it("never lets a retained group command fall through to a replacement group or guild microphone",()=>{
  const first=binding("old");bindGroupCallAudioControl(first);const view=renderVoice();const old=view.result.current.toggleMute;
  const next=binding("new");act(()=>bindGroupCallAudioControl(next));act(()=>old());expect(first.toggle).not.toHaveBeenCalled();expect(next.toggle).not.toHaveBeenCalled();expect(view.sendVoiceStateUpdate).not.toHaveBeenCalled();
  act(()=>view.result.current.toggleMute());expect(next.toggle).toHaveBeenCalledOnce();
  act(()=>{releaseGroupCallAudioControl("new");useVoiceStore.setState({currentVoiceChannelId:"guild"});});act(()=>old());expect(useVoiceStore.getState().isMuted).toBe(false);expect(view.sendVoiceStateUpdate).not.toHaveBeenCalled();view.unmount();
 });
 it("retires stale account callbacks and releases only the exact call nonce",()=>{
  const first=binding("first"),next=binding("next");bindGroupCallAudioControl(first);const retained=useGroupCallAudioControlStore.getState().control!.toggle;bindGroupCallAudioControl(next);releaseGroupCallAudioControl("first");retained();expect(first.toggle).not.toHaveBeenCalled();expect(useGroupCallAudioControlStore.getState().control?.nonce).toBe("next");
  publishAuthGenerationChange(2);toggleGroupCallMicrophone("next");expect(next.toggle).not.toHaveBeenCalled();expect(useGroupCallAudioControlStore.getState().control).toBeNull();bindGroupCallAudioControl(next);expect(useGroupCallAudioControlStore.getState().control).toBeNull();
 });
 it("preserves fresh guild/P2P precedence instead of routing those commands into a blocked group",()=>{
  const group=binding("group");bindGroupCallAudioControl(group);useVoiceStore.setState({currentVoiceChannelId:"guild"});const guild=renderVoice();act(()=>guild.result.current.toggleMute());expect(group.toggle).not.toHaveBeenCalled();expect(guild.sendVoiceStateUpdate).toHaveBeenCalledWith({is_muted:true,is_deafened:false});guild.unmount();
  useVoiceStore.setState({currentVoiceChannelId:null,isMuted:false});useP2PCallStore.setState({activeCall:{id:"private",status:"active"}as NonNullable<ReturnType<typeof useP2PCallStore.getState>["activeCall"]>});const privateCall=renderVoice();act(()=>privateCall.result.current.toggleMute());expect(group.toggle).not.toHaveBeenCalled();privateCall.unmount();
 });

 it("keeps the group shortcut owner while ringing and rejects its retained command once acceptance owns capture",()=>{
  const group=binding("group");bindGroupCallAudioControl(group);useP2PCallStore.setState({activeCall:{id:"ring",status:"ringing"}as NonNullable<ReturnType<typeof useP2PCallStore.getState>["activeCall"]>});const view=renderVoice();const beforeAccept=view.result.current.toggleMute;act(()=>beforeAccept());expect(group.toggle).toHaveBeenCalledOnce();expect(view.sendVoiceStateUpdate).not.toHaveBeenCalled();
  act(()=>useP2PCallStore.setState({activeCall:{id:"ring",status:"active"}as NonNullable<ReturnType<typeof useP2PCallStore.getState>["activeCall"]>}));act(()=>beforeAccept());expect(group.toggle).toHaveBeenCalledOnce();expect(view.sendVoiceStateUpdate).not.toHaveBeenCalled();view.unmount();
 });

});
