import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { getOverlayVoiceSession, useOverlayVoiceActions } from "./useOverlayVoiceActions";
import { useVoiceStore } from "../stores/voiceStore";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("routes exact-session actions through live call commands and releases the subscription", () => {
  let receive!: (value: { action: "toggle-mute" | "toggle-deafen"; session: string }) => void;
  const unsubscribe = vi.fn();
  vi.stubGlobal("electronAPI", { onOverlayVoiceAction: (callback: typeof receive) => { receive = callback; return unsubscribe; } });
  useVoiceStore.setState({ voiceOverlayEnabled: true, voiceOverlayQuickActions: true, currentVoiceChannelId: "call-a", _joinGeneration: 1 });
  const mute = vi.fn(), deafen = vi.fn();
  const view = renderHook(() => useOverlayVoiceActions(mute, deafen));
  const first = getOverlayVoiceSession()!;
  act(() => receive({ action: "toggle-mute", session: first }));
  expect(mute).toHaveBeenCalledOnce();
  useVoiceStore.setState({ _joinGeneration: 2 });
  act(() => receive({ action: "toggle-mute", session: first }));
  expect(mute).toHaveBeenCalledOnce();
  act(() => receive({ action: "toggle-deafen", session: getOverlayVoiceSession()! }));
  expect(deafen).toHaveBeenCalledOnce();
  useVoiceStore.setState({ voiceOverlayQuickActions: false });
  act(() => receive({ action: "toggle-deafen", session: getOverlayVoiceSession()! }));
  expect(deafen).toHaveBeenCalledOnce();
  view.unmount();
  expect(unsubscribe).toHaveBeenCalledOnce();
  useVoiceStore.setState({ voiceOverlayQuickActions: true });
  act(() => receive({ action: "toggle-deafen", session: getOverlayVoiceSession()! }));
  expect(deafen).toHaveBeenCalledOnce();
});
it("safely supports web and ignores actions after leaving the call", () => {
  vi.stubGlobal("electronAPI", undefined);
  useVoiceStore.setState({ currentVoiceChannelId: null });
  expect(getOverlayVoiceSession()).toBeNull();
  expect(() => renderHook(() => useOverlayVoiceActions(vi.fn(), vi.fn())).unmount()).not.toThrow();
});
it("revokes compatibility actions immediately and never reuses the old session after normal mode resumes",()=>{let receive!:(value:{action:"toggle-mute";session:string})=>void;vi.stubGlobal("electronAPI",{onOverlayVoiceAction:(callback:typeof receive)=>{receive=callback;return()=>{};}});useVoiceStore.setState({voiceOverlayEnabled:true,voiceOverlayQuickActions:true,voiceOverlayCompatibility:false,currentVoiceChannelId:"compat-call"});const mute=vi.fn();renderHook(()=>useOverlayVoiceActions(mute,vi.fn()));const original=getOverlayVoiceSession()!;act(()=>useVoiceStore.setState({voiceOverlayCompatibility:true}));expect(getOverlayVoiceSession()).toBeNull();act(()=>receive({action:"toggle-mute",session:original}));expect(mute).not.toHaveBeenCalled();act(()=>useVoiceStore.setState({voiceOverlayCompatibility:false}));expect(getOverlayVoiceSession()).not.toBe(original);act(()=>receive({action:"toggle-mute",session:original}));expect(mute).not.toHaveBeenCalled();act(()=>receive({action:"toggle-mute",session:getOverlayVoiceSession()!}));expect(mute).toHaveBeenCalledOnce();});
