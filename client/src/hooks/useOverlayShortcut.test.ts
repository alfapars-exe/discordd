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
