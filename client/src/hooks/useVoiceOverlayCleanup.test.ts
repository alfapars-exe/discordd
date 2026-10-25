import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useVoiceOverlayCleanup } from "./useVoiceOverlayCleanup";
import { publishAuthGenerationChange, publishAuthOwnerChange } from "../api/authSessionEvents";
import { parseVoiceOverlaySnapshot } from "../../../electron/voice-overlay-contract";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("clears native participants and game tracking on authenticated layout unmount", () => {
  const send = vi.fn();
  vi.stubGlobal("electronAPI", { sendVoiceOverlaySnapshot: send });
  const { unmount, rerender } = renderHook(useVoiceOverlayCleanup);
  expect(send).toHaveBeenCalledOnce();
  send.mockClear();
  rerender();
  expect(send).not.toHaveBeenCalled();
  unmount();
  expect(send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ enabled: false, participants: [], voiceOverlayMode: "desktop", voiceOverlayMaxParticipants: 0 }));
});

it("cleans up safely without a native bridge", () => {
  vi.stubGlobal("electronAPI", undefined);
  expect(() => renderHook(useVoiceOverlayCleanup).unmount()).not.toThrow();
});

it("queues an empty snapshot synchronously on owner and same-owner session boundaries", () => {
  const send = vi.fn();
  vi.stubGlobal("electronAPI", { sendVoiceOverlaySnapshot: send });
  const view = renderHook(useVoiceOverlayCleanup);
  send.mockClear();
  publishAuthOwnerChange("overlay-next-owner");
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ enabled: false, voiceOverlayChat: false }));
  expect(parseVoiceOverlaySnapshot(send.mock.calls[0][0])).not.toBeNull();
  expect(send.mock.calls[0][0]).not.toHaveProperty("chatMessages");
  send.mockClear();
  publishAuthGenerationChange(9001);
  expect(send).toHaveBeenCalledOnce();
  view.unmount();
  send.mockClear();
  publishAuthGenerationChange(9002);
  expect(send).not.toHaveBeenCalled();
});

it("handles rejected cleanup invokes at mount, identity change and unmount without reviving content",async()=>{
 const send=vi.fn().mockRejectedValue(new Error("IPC unavailable"));
 vi.stubGlobal("electronAPI",{sendVoiceOverlaySnapshot:send});
 const view=renderHook(useVoiceOverlayCleanup);
 await act(async()=>{publishAuthGenerationChange(9010);});
 view.unmount();await act(async()=>{});
 expect(send).toHaveBeenCalledTimes(3);
 expect(send.mock.calls.every(([snapshot])=>snapshot.enabled===false&&snapshot.participants.length===0)).toBe(true);
 send.mockClear();publishAuthGenerationChange(9011);expect(send).not.toHaveBeenCalled();
});
