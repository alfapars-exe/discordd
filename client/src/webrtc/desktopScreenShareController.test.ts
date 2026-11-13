import { expect, it, vi } from "vitest";
import type { LocalParticipant, LocalTrackPublication } from "livekit-client";
import { createDesktopScreenShareController } from "./desktopScreenShareController";

function publication(stream: string) {
  const track = { mediaStreamTrack: { enabled: true }, stop: vi.fn() };
  return { track, options: { stream } } as unknown as LocalTrackPublication;
}

function harness() {
  const owned = publication("owned"), foreign = publication("foreign");
  const participant = {
    setScreenShareEnabled: vi.fn(async () => owned),
    trackPublications: new Map([["owned", owned], ["foreign", foreign]]),
    unpublishTrack: vi.fn(async () => {}),
  };
  const operations = {
    localParticipant: participant as unknown as LocalParticipant,
    getSettings: () => ({ screenShareQuality: "1080p", screenShareFps: 60, screenShareAudio: false }),
    getDisplay: () => null,
    isMobileBrowser: () => false, canBrowserScreenShare: () => true,
    ownPublishedShare: vi.fn(() => true), startAudio: vi.fn(async () => null),
    setAudioPublication: vi.fn(), releaseOwnedShare: vi.fn(() => owned), stopAudio: vi.fn(),
    unsupported: vi.fn(), started: vi.fn(), stopped: vi.fn(), logVideo: vi.fn(), logAudio: vi.fn(), log: vi.fn(),
  };
  return { owned, foreign, participant, operations, controller: createDesktopScreenShareController(operations) };
}

it("retires only this capture's stream after a cancelled picker", async () => {
  const h = harness();
  await h.controller.start("browser", "1080p", 60, "owned", 0, false, () => true);
  expect(h.owned.track!.mediaStreamTrack.enabled).toBe(false);
  expect(h.owned.track!.stop).toHaveBeenCalledTimes(1);
  expect(h.foreign.track!.stop).not.toHaveBeenCalled();
  expect(h.participant.unpublishTrack).toHaveBeenCalledExactlyOnceWith(h.owned.track);
  expect(h.operations.started).not.toHaveBeenCalled();
});

it("does not announce a source whose ownership could not be acquired", async () => {
  const h = harness(); h.operations.ownPublishedShare.mockReturnValue(false);
  await expect(h.controller.start("browser", "1080p", 60, "owned", 0, false, () => false)).rejects.toMatchObject({ name: "AbortError" });
  expect(h.operations.started).not.toHaveBeenCalled();
  expect(h.operations.startAudio).not.toHaveBeenCalled();
});

it("reports unsupported browser capture without opening a picker", async () => {
  const h = harness(); h.operations.canBrowserScreenShare = () => false;
  await h.controller.start("browser", "1080p", 60, "owned", 0, false, () => false);
  expect(h.operations.unsupported).toHaveBeenCalledTimes(1);
  expect(h.operations.stopped).toHaveBeenCalledTimes(1);
  expect(h.participant.setScreenShareEnabled).not.toHaveBeenCalled();
});

it("releases ownership and audio before disabling desktop screen sharing", async () => {
  const h = harness(), calls: string[] = [];
  h.operations.releaseOwnedShare.mockImplementation(() => { calls.push("release"); return h.owned; });
  h.operations.stopAudio.mockImplementation(() => { calls.push("stop-audio"); });
  h.participant.unpublishTrack.mockImplementation(async () => { calls.push("unpublish"); });
  h.participant.setScreenShareEnabled.mockImplementation(async () => { calls.push("disable"); return h.owned; });
  await h.controller.stop();
  expect(calls).toEqual(["release", "stop-audio", "unpublish", "disable"]);
  expect(h.participant.setScreenShareEnabled).toHaveBeenCalledWith(false);
});
