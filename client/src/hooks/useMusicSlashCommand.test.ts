import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

const fixture = vi.hoisted(() => ({
  currentVoiceChannelId: "voice-A" as string | null,
  currentVoiceServerId: "server-A" as string | null,
  toast: vi.fn(),
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }), initReactI18next: { type: "3rdParty", init: () => {} } }));
vi.mock("../stores/voiceStore", () => ({ useVoiceStore: { getState: () => fixture } }));
// Deliberately a different browsing server: commands must follow the call.
vi.mock("../stores/serverStore", () => ({ useServerStore: { getState: () => ({ activeServerId: "server-B" }) } }));
vi.mock("../stores/toastStore", () => ({ useToastStore: (selector: (s: { addToast: typeof fixture.toast }) => unknown) => selector({ addToast: fixture.toast }) }));
vi.mock("../utils/musicRequestError", () => ({ showMusicRequestError: vi.fn() }));
vi.mock("../api/music", () => ({ playMusic: vi.fn(), searchMusic: vi.fn(), skipMusic: vi.fn(), pauseMusic: vi.fn(), resumeMusic: vi.fn(), stopMusic: vi.fn() }));

import { useMusicSlashCommand } from "./useMusicSlashCommand";
import { playMusic, searchMusic, skipMusic, pauseMusic, resumeMusic, stopMusic } from "../api/music";
import { showMusicRequestError } from "../utils/musicRequestError";
import type { PlayMusicResponse } from "../types/music";

beforeEach(() => {
  vi.resetAllMocks();
  fixture.currentVoiceChannelId = "voice-A";
  fixture.currentVoiceServerId = "server-A";
  vi.mocked(skipMusic).mockResolvedValue({ success: true });
  vi.mocked(searchMusic).mockResolvedValue({ success: true, data: { results: [] } });
});

describe("music command call ownership", () => {
  it("targets the connected voice server while browsing another server", async () => {
    const { result } = renderHook(() => useMusicSlashCommand());
    expect(await result.current("/skip")).toEqual({ handled: true, outcome: "success" });
    expect(skipMusic).toHaveBeenCalledWith("server-A", "voice-A");
  });

  it("does not guess a server when the voice session has no origin", async () => {
    fixture.currentVoiceServerId = null;
    const { result } = renderHook(() => useMusicSlashCommand());
    expect(await result.current("/skip")).toEqual({ handled: true, outcome: "failed" });
    expect(skipMusic).not.toHaveBeenCalled();
    expect(fixture.toast).toHaveBeenCalledWith("error", "notInVoice");
  });

  it.each(["hello", "/unknown x", "/playlist", "https://youtu.be/example"])("leaves ordinary input to chat: %s", async (text) => {
    const { result } = renderHook(() => useMusicSlashCommand());
    expect(await result.current(text)).toEqual({ handled: false });
    expect(playMusic).not.toHaveBeenCalled();
    expect(fixture.toast).not.toHaveBeenCalled();
  });

  it.each([" ", "\t", "\n"])("recognizes pasted play arguments separated by %j", async (separator) => {
    vi.mocked(playMusic).mockResolvedValue({ success: true, data: { added_tracks: [{}] } as PlayMusicResponse });
    const { result } = renderHook(() => useMusicSlashCommand());
    expect(await result.current(`  /PLAY${separator}https://youtu.be/example  `)).toEqual({ handled: true, outcome: "success" });
    expect(playMusic).toHaveBeenCalledWith("server-A", "voice-A", "https://youtu.be/example");
    expect(fixture.toast).toHaveBeenLastCalledWith("success", "addedToQueue");
  });

  it("retains a missing-URL command without an API request", async () => {
    const { result } = renderHook(() => useMusicSlashCommand());
    expect(await result.current("/play \n")).toEqual({ handled: true, outcome: "failed" });
    expect(playMusic).not.toHaveBeenCalled();
    expect(fixture.toast).toHaveBeenCalledWith("error", "invalidYouTubeUrl");
  });

  it("resolves a play name to the first selectable YouTube result", async () => {
    vi.mocked(searchMusic).mockResolvedValue({ success: true, data: { results: [{ video_id: "abcdefghijk", title: "Result", duration_seconds: 10, url: "https://youtu.be/abcdefghijk", requested_by_user_id: "", requested_by_name: "" }] } });
    vi.mocked(playMusic).mockResolvedValue({ success: true, data: { added_tracks: [{}] } as PlayMusicResponse });
    const { result } = renderHook(() => useMusicSlashCommand());
    expect(await result.current("/play daft punk")).toEqual({ handled: true, outcome: "success" });
    expect(searchMusic).toHaveBeenCalledWith("server-A", "voice-A", "daft punk");
    expect(playMusic).toHaveBeenCalledWith("server-A", "voice-A", "https://youtu.be/abcdefghijk");
  });

  it.each([undefined, {}, { added_tracks: [] }])("rejects malformed/empty success responses: %j", async (data) => {
    vi.mocked(playMusic).mockResolvedValue({ success: true, data: data as PlayMusicResponse | undefined });
    const { result } = renderHook(() => useMusicSlashCommand());
    expect(await result.current("/play https://youtu.be/example")).toEqual({ handled: true, outcome: "failed" });
    expect(fixture.toast).toHaveBeenLastCalledWith("error", "playError");
  });

  it("retains rejected playback and uses shared error classification", async () => {
    const response = { success: false, status: 403, code: "FORBIDDEN" };
    vi.mocked(playMusic).mockResolvedValue(response);
    const { result } = renderHook(() => useMusicSlashCommand());
    expect(await result.current("/play https://youtu.be/example")).toEqual({ handled: true, outcome: "failed" });
    expect(showMusicRequestError).toHaveBeenCalledWith(response, "play");
  });

  it("distinguishes a timed-out POST from a confirmed rejection", async () => {
    vi.mocked(playMusic).mockResolvedValue({ success: false, isTimeout: true });
    const { result } = renderHook(() => useMusicSlashCommand());
    expect(await result.current("/play https://youtu.be/example")).toEqual({ handled: true, outcome: "pending" });
    expect(playMusic).toHaveBeenCalledTimes(1);
    expect(showMusicRequestError).toHaveBeenCalledWith({ success: false, isTimeout: true }, "play");
  });

  it.each([
    ["pause", pauseMusic, "commandPaused"],
    ["resume", resumeMusic, "commandResumed"],
    ["skip", skipMusic, "commandSkipped"],
    ["stop", stopMusic, "commandStopped"],
  ] as const)("acknowledges /%s even when the music panel is not visible", async (command, api, key) => {
    vi.mocked(api).mockResolvedValue({ success: true });
    const { result } = renderHook(() => useMusicSlashCommand());
    expect(await result.current(`/${command}`)).toEqual({ handled: true, outcome: "success" });
    expect(api).toHaveBeenCalledWith("server-A", "voice-A");
    expect(fixture.toast).toHaveBeenLastCalledWith("success", key);
  });

  it("retains a rejected control command", async () => {
    const response = { success: false, status: 429 };
    vi.mocked(skipMusic).mockResolvedValue(response);
    const { result } = renderHook(() => useMusicSlashCommand());
    expect(await result.current("/skip")).toEqual({ handled: true, outcome: "failed" });
    expect(showMusicRequestError).toHaveBeenCalledWith(response, "control");
  });

  it.each(["play https://youtu.be/example", "skip"])("does not leak thrown provider errors for /%s", async (command) => {
    const error = new Error("private extraction credentials /tmp/cookies");
    vi.mocked(playMusic).mockRejectedValue(error);
    vi.mocked(skipMusic).mockRejectedValue(error);
    const { result } = renderHook(() => useMusicSlashCommand());
    expect(await result.current(`/${command}`)).toEqual({ handled: true, outcome: "failed" });
    expect(fixture.toast).toHaveBeenLastCalledWith("error", command.startsWith("play") ? "playError" : "controlError");
  });
});
