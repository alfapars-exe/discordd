import {registerCaptureAdmission}from "../audio/microphoneAdmission";
import type {LocalParticipant}from "livekit-client";
import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { create } from "zustand";
import { beginShortcutCapture } from "../stores/shortcutCaptureStore";
const platform = vi.hoisted(() => ({ electron: false }));
vi.mock("../utils/constants", () => ({ isElectron: () => platform.electron }));
vi.mock("../stores/voiceStore", () => ({ useVoiceStore: create(() => ({ inputMode: "push_to_talk", pttKey: "Space", currentVoiceChannelId: "voice", isMuted: false, isServerMuted: false })) }));
import { usePushToTalk } from "./usePushToTalk";
afterEach(() => { platform.electron = false; window.electronAPI = undefined; });
it("releases a held browser microphone while recording and resumes after capture", () => {
  const setMicEnabled = vi.fn();
  renderHook(() => usePushToTalk({ setMicEnabled }));
  document.dispatchEvent(new KeyboardEvent("keydown", { code: "Space", bubbles: true }));
  expect(setMicEnabled).toHaveBeenLastCalledWith(true);
  let stop!: () => void;
  act(() => { stop = beginShortcutCapture(); });
  expect(setMicEnabled).toHaveBeenLastCalledWith(false);
  setMicEnabled.mockClear();
  document.dispatchEvent(new KeyboardEvent("keydown", { code: "Space", bubbles: true }));
  expect(setMicEnabled).not.toHaveBeenCalled();
  act(() => stop());
  document.dispatchEvent(new KeyboardEvent("keydown", { code: "Space", bubbles: true }));
  expect(setMicEnabled).toHaveBeenLastCalledWith(true);
});
it("releases the exact native lease during capture and ignores stale callbacks", async() => {
  platform.electron = true;
  const unsubscribe=vi.fn();const api = {acquirePTTLease:vi.fn(async()=>"lease"),releasePTTLease:vi.fn(async()=>{}),onPTTLeaseSignal:vi.fn((_cb:unknown)=>unsubscribe)};
  window.electronAPI = api as unknown as Window["electronAPI"];
  const setMicEnabled=vi.fn();renderHook(()=>usePushToTalk({setMicEnabled}));await act(async()=>{});
  const signal=api.onPTTLeaseSignal.mock.calls[0][0] as unknown as (value:{leaseId:string;pressed:boolean})=>void;
  signal({leaseId:"lease",pressed:true});expect(setMicEnabled).toHaveBeenLastCalledWith(true);
  let stop!:()=>void;act(()=>{stop=beginShortcutCapture();});expect(api.releasePTTLease).toHaveBeenCalledWith("lease");expect(unsubscribe).toHaveBeenCalledOnce();expect(setMicEnabled).toHaveBeenLastCalledWith(false);
  setMicEnabled.mockClear();signal({leaseId:"lease",pressed:true});expect(setMicEnabled).not.toHaveBeenCalled();await act(async()=>stop());expect(api.acquirePTTLease).toHaveBeenCalledTimes(2);
});

it("guild encrypted admission closure releases native lease synchronously",async()=>{
 platform.electron=true;const participant={}as LocalParticipant,admission=registerCaptureAdmission(participant,()=>true);admission.open();const api={acquirePTTLease:vi.fn(async()=>"guild"),releasePTTLease:vi.fn(async()=>{}),onPTTLeaseSignal:vi.fn((_cb:unknown)=>vi.fn())};window.electronAPI=api as unknown as Window["electronAPI"];const setMicEnabled=vi.fn();const view=renderHook(()=>usePushToTalk({setMicEnabled,participant}));await act(async()=>{});
 const signal=api.onPTTLeaseSignal.mock.calls[0][0]as (value:{leaseId:string;pressed:boolean})=>void;signal({leaseId:"guild",pressed:true});expect(setMicEnabled).toHaveBeenLastCalledWith(true);act(()=>admission.close());expect(api.releasePTTLease).toHaveBeenCalledWith("guild");expect(setMicEnabled).toHaveBeenLastCalledWith(false);setMicEnabled.mockClear();signal({leaseId:"guild",pressed:true});expect(setMicEnabled).not.toHaveBeenCalled();view.unmount();
});
