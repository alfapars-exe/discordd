import { publishAuthGenerationChange } from "../api/authSessionEvents";
import {useEffect} from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useOverlayShortcut, useOverlayShortcutStatus } from "./useOverlayShortcut";
import { useVoiceStore } from "../stores/voiceStore";
import { useShortcutBindingsStore } from "../stores/shortcutBindingsStore";
import { beginShortcutCapture } from "../stores/shortcutCaptureStore";

beforeEach(() => {
  useVoiceStore.setState({ voiceOverlayEnabled: true, voiceOverlayCompatibility:false, inputMode: "voice_activity", pttKey: "Space", muteHotkeyEnabled: false });
  useShortcutBindingsStore.setState({ bindings: { "overlay-lock": { code: "KeyO", key: "o", ctrl: true, shift: false, alt: true, meta: false } } });
  useOverlayShortcutStatus.setState({ failed: false });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("registers a bounded device chord, suspends during recording and releases on unmount", async () => {
  const configure = vi.fn().mockResolvedValue(true);
  vi.stubGlobal("electronAPI", { setOverlayShortcut: configure });
  const view = renderHook(useOverlayShortcut);
  expect(configure).toHaveBeenLastCalledWith({ code: "KeyO", ctrl: true, shift: false, alt: true, meta: false });
  let stop!: () => void;
  act(() => { stop = beginShortcutCapture(); });
  expect(configure).toHaveBeenLastCalledWith(null);
  act(() => stop());
  expect(configure).toHaveBeenLastCalledWith(expect.objectContaining({ code: "KeyO" }));
  act(() => useVoiceStore.setState({ voiceOverlayEnabled: false }));
  expect(configure).toHaveBeenLastCalledWith(null);
  view.unmount();
  expect(configure).toHaveBeenLastCalledWith(null);
});

it("surfaces OS conflicts without stale replies overwriting newer configuration", async () => {
  let resolve!: (ok: boolean) => void;
  const configure = vi.fn().mockImplementationOnce(() => new Promise<boolean>((done) => { resolve = done; })).mockResolvedValue(false);
  vi.stubGlobal("electronAPI", { setOverlayShortcut: configure });
  renderHook(useOverlayShortcut);
  act(() => useShortcutBindingsStore.setState({ bindings: { "overlay-lock": { code: "KeyP", key: "p", ctrl: true, alt: true, shift: false, meta: false } } }));
  await waitFor(() => expect(useOverlayShortcutStatus.getState().failed).toBe(true));
  await act(async () => resolve(true));
  expect(useOverlayShortcutStatus.getState().failed).toBe(true);
});

it("does not configure a disabled command or require a bridge on web", () => {
  const configure = vi.fn().mockResolvedValue(true);
  vi.stubGlobal("electronAPI", { setOverlayShortcut: configure });
  useShortcutBindingsStore.setState({ bindings: { disabledCommands: ["overlay-lock"] } });
  const view = renderHook(useOverlayShortcut);
  expect(configure).toHaveBeenLastCalledWith(null);
  view.unmount();
  vi.stubGlobal("electronAPI", undefined);
  expect(() => renderHook(useOverlayShortcut).unmount()).not.toThrow();
});
it("suspends an already configured chord if the physical key becomes a PTT binding", async () => {
  const configure = vi.fn().mockResolvedValue(true);
  vi.stubGlobal("electronAPI", { setOverlayShortcut: configure });
  renderHook(useOverlayShortcut);
  act(() => useVoiceStore.setState({ inputMode: "push_to_talk", pttKey: "KeyO" }));
  expect(configure).toHaveBeenLastCalledWith(null);
  await waitFor(() => expect(useOverlayShortcutStatus.getState().failed).toBe(true));
});

it("releases the OS overlay shortcut in compatibility and restores only its binding in normal mode",async()=>{const configure=vi.fn().mockResolvedValue(true);vi.stubGlobal("electronAPI",{setOverlayShortcut:configure});renderHook(useOverlayShortcut);expect(configure).toHaveBeenLastCalledWith(expect.objectContaining({code:"KeyO"}));act(()=>useVoiceStore.setState({voiceOverlayCompatibility:true}));expect(configure).toHaveBeenLastCalledWith(null);act(()=>useVoiceStore.setState({voiceOverlayCompatibility:false}));expect(configure).toHaveBeenLastCalledWith(expect.objectContaining({code:"KeyO"}));});

it("does not hide failed native unregister while compatibility is requested",async()=>{const configure=vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false);vi.stubGlobal("electronAPI",{setOverlayShortcut:configure});renderHook(useOverlayShortcut);await waitFor(()=>expect(useOverlayShortcutStatus.getState().failed).toBe(false));act(()=>useVoiceStore.setState({voiceOverlayCompatibility:true}));await waitFor(()=>expect(useOverlayShortcutStatus.getState().failed).toBe(true));expect(configure).toHaveBeenLastCalledWith(null);});

it("reconfigures after a fresh owner policy projection even when the stored chord is unchanged",()=>{const configure=vi.fn().mockResolvedValue(true);vi.stubGlobal("electronAPI",{setOverlayShortcut:configure});const view=renderHook(({scope})=>useOverlayShortcut(scope),{initialProps:{scope:"owner:1"}});expect(configure).toHaveBeenCalledOnce();view.rerender({scope:"owner:2"});expect(configure).toHaveBeenCalledTimes(2);expect(configure).toHaveBeenLastCalledWith(expect.objectContaining({code:"KeyO"}));});

it("registers after the native policy effect when normal mode resumes",async()=>{let suspended=false;const order:string[]=[];const configure=vi.fn(async(binding:{code:string}|null)=>{order.push(binding?"binding":"release");return binding?!suspended:true;});vi.stubGlobal("electronAPI",{setOverlayShortcut:configure});renderHook(()=>{const compatibility=useVoiceStore(state=>state.voiceOverlayCompatibility);useEffect(()=>{suspended=compatibility;order.push(compatibility?"policy-on":"policy-off");},[compatibility]);useOverlayShortcut("owner:1");});await waitFor(()=>expect(useOverlayShortcutStatus.getState().failed).toBe(false));act(()=>useVoiceStore.setState({voiceOverlayCompatibility:true}));expect(order.slice(-2)).toEqual(["policy-on","release"]);act(()=>useVoiceStore.setState({voiceOverlayCompatibility:false}));expect(order.slice(-2)).toEqual(["policy-off","binding"]);await waitFor(()=>expect(useOverlayShortcutStatus.getState().failed).toBe(false));});


it("waits for a real policy acknowledgement and releases immediately on compatibility entry",async()=>{
 let accept!:(value:boolean)=>void; const ack=new Promise<boolean>(done=>{accept=done;});
 const configure=vi.fn().mockResolvedValue(true);vi.stubGlobal("electronAPI",{setOverlayShortcut:configure});
 renderHook(()=>useOverlayShortcut("owner:1",()=>ack));expect(configure).not.toHaveBeenCalled();
 act(()=>useVoiceStore.setState({voiceOverlayCompatibility:true}));expect(configure).toHaveBeenLastCalledWith(null);
 await act(async()=>accept(true));expect(configure.mock.calls.every(([binding])=>binding===null)).toBe(true);
});
it("rejects false and legacy void policy acknowledgements without reserving the chord",async()=>{
 const configure=vi.fn().mockResolvedValue(true);vi.stubGlobal("electronAPI",{setOverlayShortcut:configure});
 const view=renderHook(()=>useOverlayShortcut("owner:1",()=>Promise.resolve(false)));
 await waitFor(()=>expect(useOverlayShortcutStatus.getState().failed).toBe(true));expect(configure).toHaveBeenLastCalledWith(null);view.unmount();
 renderHook(()=>useOverlayShortcut("owner:2",()=>Promise.resolve(undefined as unknown as boolean)));
 await waitFor(()=>expect(configure.mock.calls.every(([binding])=>binding===null)).toBe(true));
});
it("only registers the latest scope after out-of-order policy acknowledgements",async()=>{
 const resolvers:Array<(value:boolean)=>void>=[]; const pending=[new Promise<boolean>(r=>resolvers.push(r)),new Promise<boolean>(r=>resolvers.push(r))];
 const configure=vi.fn().mockResolvedValue(true);vi.stubGlobal("electronAPI",{setOverlayShortcut:configure});
 const view=renderHook(({scope})=>useOverlayShortcut(scope,()=>pending[scope==='first'?0:1]),{initialProps:{scope:'first'}});
 await act(async()=>{});view.rerender({scope:'second'});await act(async()=>{});
 await act(async()=>resolvers[0](true));expect(configure).not.toHaveBeenCalled();
 await act(async()=>resolvers[1](true));expect(configure).toHaveBeenCalledOnce();
});

it("does not reserve a chord when the authenticated generation changes before acknowledgement",async()=>{
 let accept!:(value:boolean)=>void;const ack=new Promise<boolean>(done=>{accept=done;});
 const configure=vi.fn().mockResolvedValue(true);vi.stubGlobal("electronAPI",{setOverlayShortcut:configure});
 renderHook(()=>useOverlayShortcut("owner:1",()=>ack));await act(async()=>{});
 act(()=>publishAuthGenerationChange(987));await act(async()=>accept(true));expect(configure).not.toHaveBeenCalled();
 publishAuthGenerationChange(0);
});

it("surfaces a bounded acknowledgement timeout and ignores its later acceptance",async()=>{
 vi.useFakeTimers();
 try {
  let accept!:(value:boolean)=>void;const ack=new Promise<boolean>(done=>{accept=done;});
  const configure=vi.fn().mockResolvedValue(true);vi.stubGlobal("electronAPI",{setOverlayShortcut:configure});
  renderHook(()=>useOverlayShortcut("owner:timeout",()=>ack));await act(async()=>{});
  expect(configure).not.toHaveBeenCalled();
  await act(async()=>{await vi.advanceTimersByTimeAsync(10_000);});
  expect(useOverlayShortcutStatus.getState().failed).toBe(true);
  await act(async()=>accept(true));expect(configure).not.toHaveBeenCalled();
 } finally {vi.useRealTimers();}
});
