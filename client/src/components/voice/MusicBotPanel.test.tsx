vi.mock("../../api/musicProtocol",()=>({captureMusicScope:(server:string,channel:string)=>{const v=useVoiceStore.getState(),reset=v.musicBotResetRevision;return {current:()=>{const now=useVoiceStore.getState();return now.currentVoiceServerId===server&&now.currentVoiceChannelId===channel&&now.musicBotResetRevision===reset;}};}}));
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RoomEvent } from "livekit-client";
import type { VoiceStore } from "../../stores/voiceStore";
import type { MusicBotChannelState } from "../../types/music";

const fixture = vi.hoisted(() => ({ room: { on: vi.fn(), off: vi.fn() }, toast: vi.fn(), showError: vi.fn() }));
vi.mock("@livekit/components-react", () => ({ useRoomContext: () => fixture.room }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }), initReactI18next: { type: "3rdParty", init: () => {} } }));
vi.mock("../../stores/voiceStore", async () => {
  const { create } = await import("zustand");
  const { createMusicBotSlice } = await import("../../stores/slices/musicBotSlice");
  return { useVoiceStore: create<VoiceStore>((set, get, store) => ({
    ...createMusicBotSlice(set, get, store),
    currentVoiceChannelId: "a",
    currentVoiceServerId: "server-a",
    userVolumes: {},
    setUserVolume: (userId: string, volume: number) => set((state) => ({ userVolumes: { ...state.userVolumes, [userId]: volume } })),
  }) as VoiceStore) };
});
vi.mock("../../stores/toastStore", () => ({ useToastStore: { getState: () => ({ addToast: fixture.toast }) } }));
vi.mock("../../utils/musicRequestError", () => ({ showMusicRequestError: fixture.showError }));
vi.mock("../../api/music", () => ({ getMusicState: vi.fn(), retryMusicMutation:vi.fn(),subscribeMusicRetries:vi.fn(()=>()=>{}),hasPendingMusicMutation:vi.fn(()=>false), pauseMusic: vi.fn(), resumeMusic: vi.fn(), skipMusic: vi.fn(), stopMusic: vi.fn(), searchMusic: vi.fn(), playMusic: vi.fn(), removeMusicQueueItem: vi.fn(), reorderMusicQueue: vi.fn(), shuffleMusicQueue: vi.fn(), setMusicRepeatMode: vi.fn(), restoreMusicSession: vi.fn(), seekMusic: vi.fn() }));

import MusicBotPanel from "./MusicBotPanel";
import { useVoiceStore } from "../../stores/voiceStore";
import { getMusicState, pauseMusic, resumeMusic, skipMusic, stopMusic, searchMusic, playMusic, removeMusicQueueItem, reorderMusicQueue, shuffleMusicQueue, setMusicRepeatMode, restoreMusicSession, seekMusic } from "../../api/music";

function song(overrides: Partial<MusicBotChannelState> = {}): MusicBotChannelState {
  return { channel_id: "a", server_id: "server-a", is_active: true, is_paused: false, queue: [], elapsed_seconds: 30,
    started_at: new Date(Date.now() - 90_000).toISOString(),
    current_track: { video_id: "v", title: "A song", duration_seconds: 180, url: "https://youtube.com/watch?v=v", requested_by_user_id: "me", requested_by_name: "Me" }, ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
  useVoiceStore.setState({ currentVoiceChannelId: "a", currentVoiceServerId: "server-a", musicBotStates: {}, musicBotRevisions: {}, musicBotUpdatedAt: {}, musicBotResetRevision: 0, userVolumes: {} });
  useVoiceStore.getState().setMusicBotState("a", song());
  vi.mocked(getMusicState).mockImplementation(async () => ({ success: true, data: useVoiceStore.getState().musicBotStates.a }));
  for (const fn of [pauseMusic, resumeMusic, skipMusic, stopMusic]) vi.mocked(fn).mockResolvedValue({ success: true });
  vi.mocked(searchMusic).mockResolvedValue({ success: true, data: { results: [] } });
  vi.mocked(playMusic).mockResolvedValue({ success: true, data: { added_tracks: [song().current_track!] } });
  vi.mocked(removeMusicQueueItem).mockResolvedValue({ success: true, data: { status: "ok" } });
  vi.mocked(reorderMusicQueue).mockResolvedValue({ success: true, data: { status: "ok" } });
  vi.mocked(shuffleMusicQueue).mockResolvedValue({ success: true, data: { status: "ok" } });
  vi.mocked(setMusicRepeatMode).mockResolvedValue({ success: true, data: { status: "ok" } });
  vi.mocked(restoreMusicSession).mockResolvedValue({ success: true, data: { status: "ok" } });
  vi.mocked(seekMusic).mockResolvedValue({ success: true, data: { status: "ok" } });
});

describe("MusicBotPanel", () => {
  it("shows and edits restored queue entries without starting playback", async () => {
    useVoiceStore.getState().setMusicBotState("a", song({ session_id: "saved", revision: 3, is_active: false, is_paused: true, current_track: null, queue: [
      { ...song().current_track!, queue_item_id: "saved-one", title: "Duplicate saved song" },
      { ...song().current_track!, queue_item_id: "saved-two", title: "Duplicate saved song" },
    ] }));
    render(<MusicBotPanel channelId="a" />);
    expect(await screen.findAllByText("Duplicate saved song")).toHaveLength(2);
    fireEvent.click(screen.getAllByRole("button", { name: "moveTrackUp" })[1]);
    await waitFor(() => expect(reorderMusicQueue).toHaveBeenCalledWith("server-a", "a", ["saved-two", "saved-one"], 3));
    await waitFor(() => expect(screen.getAllByRole("button", { name: "removeTrack" })[0]).not.toBeDisabled());
    fireEvent.click(screen.getAllByRole("button", { name: "removeTrack" })[0]);
    await waitFor(() => expect(removeMusicQueueItem).toHaveBeenCalledWith("server-a", "a", "saved-one", 3));
    await waitFor(() => expect(screen.getByRole("button", { name: "stop" })).not.toBeDisabled());
    expect(restoreMusicSession).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "stop" }));
    await waitFor(() => expect(stopMusic).toHaveBeenCalledWith("server-a", "a"));
    expect(restoreMusicSession).not.toHaveBeenCalled();
    expect(playMusic).not.toHaveBeenCalled();
    expect(reorderMusicQueue).toHaveBeenCalledOnce();
  });

  it("does not reinterpret an old Pause click after the server already paused playback", async () => {
    render(<MusicBotPanel channelId="a" />);
    const pause = await screen.findByRole("button", { name: "pause" });
    act(() => {
      const current = useVoiceStore.getState().musicBotStates.a;
      useVoiceStore.getState().setMusicBotState("a", { ...current, is_paused: true });
      fireEvent.click(pause);
    });
    expect(pauseMusic).not.toHaveBeenCalled();
    expect(resumeMusic).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "resume" }));
    await waitFor(() => expect(resumeMusic).toHaveBeenCalledOnce());
  });

  it("does not apply an old rendered Skip control to a replacement track before React refreshes", async () => {
    render(<MusicBotPanel channelId="a" />);
    const skip = await screen.findByRole("button", { name: "skip" });
    act(() => {
      useVoiceStore.getState().setMusicBotState("a", song({ current_track: { ...song().current_track!, video_id: "replacement", title: "Replacement" } }));
      fireEvent.click(skip);
    });
    expect(skipMusic).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "skip" }));
    await waitFor(() => expect(skipMusic).toHaveBeenCalledOnce());
  });

  it.each(["success", "failure"] as const)("keeps a replacement query's results when the previous query returns %s late", async (outcome) => {
    let finishOld!: (value: Awaited<ReturnType<typeof searchMusic>>) => void;
    vi.mocked(searchMusic).mockReturnValueOnce(new Promise(resolve => { finishOld = resolve; }))
      .mockResolvedValueOnce({ success: true, data: { results: [{ ...song().current_track!, video_id: "new", title: "New query result" }] } });
    render(<MusicBotPanel channelId="a" />);
    const input = screen.getByRole("textbox", { name: "searchPlaceholder" });
    fireEvent.change(input, { target: { value: "old query" } });
    fireEvent.submit(input.closest("form")!);
    fireEvent.change(input, { target: { value: "new query" } });
    expect(screen.getByRole("button", { name: "search" })).not.toBeDisabled();
    fireEvent.submit(input.closest("form")!);
    expect(await screen.findByText("New query result")).toBeInTheDocument();
    await act(async () => finishOld(outcome === "success"
      ? { success: true, data: { results: [{ ...song().current_track!, video_id: "old", title: "Obsolete result" }] } }
      : { success: false, error: "old failure" }));
    expect(screen.getByText("New query result")).toBeInTheDocument();
    expect(screen.queryByText("Obsolete result")).toBeNull();
    expect(fixture.showError).not.toHaveBeenCalled();
    expect(fixture.toast).not.toHaveBeenCalled();
    expect(playMusic).not.toHaveBeenCalled();
  });

  it.each(["reject", "failure"] as const)("ignores an unmounted search's late %s without global feedback", async (outcome) => {
    let resolve!: (value: Awaited<ReturnType<typeof searchMusic>>) => void;
    let reject!: (reason: Error) => void;
    vi.mocked(searchMusic).mockReturnValueOnce(new Promise((done, fail) => { resolve = done; reject = fail; }));
    const view = render(<MusicBotPanel channelId="a" />);
    fireEvent.change(screen.getByRole("textbox", { name: "searchPlaceholder" }), { target: { value: "song" } });
    const form = screen.getByRole("textbox", { name: "searchPlaceholder" }).closest("form")!;
    act(() => { fireEvent.submit(form); fireEvent.submit(form); });
    expect(searchMusic).toHaveBeenCalledOnce();
    view.unmount();
    await act(async () => {
      if (outcome === "reject") reject(new Error("offline"));
      else resolve({ success: false, error: "offline" });
    });
    expect(fixture.toast).not.toHaveBeenCalled();
    expect(fixture.showError).not.toHaveBeenCalled();
    expect(playMusic).not.toHaveBeenCalled();
  });

  it("rejects a stale or cancelled queue drag, then permits a fresh reorder", async () => {
    const base = song({ session_id: "session", revision: 3, queue: [
      { ...song().current_track!, queue_item_id: "first", title: "Queue first" },
      { ...song().current_track!, queue_item_id: "second", title: "Queue second" },
    ] });
    useVoiceStore.getState().setMusicBotState("a", base);
    render(<MusicBotPanel channelId="a" />);
    const first = (await screen.findByText("Queue first")).closest("li")!;
    const second = screen.getByText("Queue second").closest("li")!;
    fireEvent.dragStart(first);
    act(() => useVoiceStore.getState().setMusicBotState("a", { ...base, revision: 4 }));
    fireEvent.drop(second);
    expect(reorderMusicQueue).not.toHaveBeenCalled();
    fireEvent.dragStart(first);
    fireEvent.dragEnd(first);
    fireEvent.drop(second);
    expect(reorderMusicQueue).not.toHaveBeenCalled();
    fireEvent.dragStart(first);
    fireEvent.drop(second);
    await waitFor(() => expect(reorderMusicQueue).toHaveBeenCalledWith("server-a", "a", ["second", "first"], 4));
    expect(reorderMusicQueue).toHaveBeenCalledOnce();
  });

  it("searches by name and queues the selected YouTube result", async () => {
    const result = { ...song().current_track!, video_id: "abcdefghijk", title: "Search result" };
    vi.mocked(searchMusic).mockResolvedValue({ success: true, data: { results: [result] } });
    render(<MusicBotPanel channelId="a" />);
    fireEvent.change(screen.getByRole("textbox", { name: "searchPlaceholder" }), { target: { value: "daft punk" } });
    fireEvent.click(screen.getByRole("button", { name: "search" }));
    await screen.findByText("Search result");
    fireEvent.click(screen.getByRole("button", { name: "add" }));
    await waitFor(() => expect(playMusic).toHaveBeenCalledWith("server-a", "a", result.url));
  });

  it("removes exactly one duplicate track using its queue identity and revision", async () => {
    useVoiceStore.getState().setMusicBotState("a", song({ revision: 9, queue: [
      { ...song().current_track!, queue_item_id: "item-one", title: "Duplicate" },
      { ...song().current_track!, queue_item_id: "item-two", title: "Duplicate" },
    ] }));
    render(<MusicBotPanel channelId="a" />);
    const buttons = await screen.findAllByRole("button", { name: "removeTrack" });
    fireEvent.click(buttons[1]!);
    await waitFor(() => expect(removeMusicQueueItem).toHaveBeenCalledWith("server-a", "a", "item-two", 9));
  });

  it("offers a keyboard-operable queue reorder action", async () => {
    useVoiceStore.getState().setMusicBotState("a", song({ revision: 3, queue: [
      { ...song().current_track!, queue_item_id: "first", title: "First" },
      { ...song().current_track!, queue_item_id: "second", title: "Second" },
    ] }));
    render(<MusicBotPanel channelId="a" />);
    const moveUp = await screen.findAllByRole("button", { name: "moveTrackUp" });
    fireEvent.click(moveUp[1]!);
    await waitFor(() => expect(reorderMusicQueue).toHaveBeenCalledWith("server-a", "a", ["second", "first"], 3));
  });

  it("shuffles pending tracks and cycles repeat mode", async () => {
    useVoiceStore.getState().setMusicBotState("a", song({ revision: 4, repeat_mode: "one", queue: [
      { ...song().current_track!, queue_item_id: "first", title: "First" },
      { ...song().current_track!, queue_item_id: "second", title: "Second" },
    ] }));
    render(<MusicBotPanel channelId="a" />);
    fireEvent.click(await screen.findByRole("button", { name: "shuffle" }));
    await waitFor(() => expect(shuffleMusicQueue).toHaveBeenCalledWith("server-a", "a", 4));
    fireEvent.click(screen.getByRole("button", { name: "repeat_one" }));
    await waitFor(() => expect(setMusicRepeatMode).toHaveBeenCalledWith("server-a", "a", "all"));
  });

  it("changes only this listener's music-bot participant volume", async () => {
    render(<MusicBotPanel channelId="a" />);
    const slider = await screen.findByRole("slider", { name: "personalVolume" });
    fireEvent.change(slider, { target: { value: "45" } });
    expect(useVoiceStore.getState().userVolumes["__music_bot__:a"]).toBe(45);
    expect(useVoiceStore.getState().userVolumes.other).toBeUndefined();
  });

  it("seeks a finite track from the accessible timeline", async () => {
    render(<MusicBotPanel channelId="a" />);
    const slider = await screen.findByRole("slider", { name: "seek" });
    fireEvent.change(slider, { target: { value: "75" } });
    fireEvent.pointerUp(slider, { target: { value: "75" } });
    await waitFor(() => expect(seekMusic).toHaveBeenCalledWith("server-a", "a", 75));
  });

  it("discards a seek draft when the same video advances to another queue entry", async () => {
    const first = song({ session_id: "session", revision: 1, current_track: { ...song().current_track!, queue_item_id: "first" } });
    useVoiceStore.getState().setMusicBotState("a", first);
    render(<MusicBotPanel channelId="a" />);
    const slider = await screen.findByRole("slider", { name: "seek" });
    fireEvent.change(slider, { target: { value: "75" } });
    const second = { ...first, revision: 2, current_track: { ...first.current_track!, queue_item_id: "second" }, elapsed_seconds: 5 };
    act(() => useVoiceStore.getState().setMusicBotState("a", second));
    expect(slider).not.toHaveValue("75");
    // Continued pointer movement must not silently adopt the replacement track.
    fireEvent.change(slider, { target: { value: "80" } });
    fireEvent.pointerUp(slider, { target: { value: "75" } });
    expect(seekMusic).not.toHaveBeenCalled();
    fireEvent.change(slider, { target: { value: "15" } });
    fireEvent.keyUp(slider, { key: "ArrowRight" });
    await waitFor(() => expect(seekMusic).toHaveBeenCalledWith("server-a", "a", 15));
  });

  it.each(["pointerCancel", "blur"] as const)("does not commit an abandoned seek after %s", async (event) => {
    render(<MusicBotPanel channelId="a" />);
    const slider = await screen.findByRole("slider", { name: "seek" });
    fireEvent.change(slider, { target: { value: "75" } });
    fireEvent[event](slider);
    fireEvent.pointerUp(slider, { target: { value: "75" } });
    expect(seekMusic).not.toHaveBeenCalled();
  });

  it("shows a restarted queue as paused and resumes only after explicit action", async () => {
    useVoiceStore.getState().setMusicBotState("a", song({ is_active: false, is_paused: true, current_track: null, queue: [
      { ...song().current_track!, queue_item_id: "saved", title: "Saved track" },
    ] }));
    render(<MusicBotPanel channelId="a" />);
    expect(await screen.findByText("restoredTitle")).toBeVisible();
    expect(restoreMusicSession).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "restorePlayback" }));
    await waitFor(() => expect(restoreMusicSession).toHaveBeenCalledWith("server-a", "a"));
  });

  it("uses the connected voice server and actual sample position", async () => {
    render(<MusicBotPanel channelId="a" />);
    await screen.findByText("0:30");
    expect(getMusicState).toHaveBeenCalledWith("server-a", "a");
    fireEvent.click(screen.getByRole("button", { name: "pause" }));
    await waitFor(() => expect(pauseMusic).toHaveBeenCalledWith("server-a", "a"));
  });

  it("does not replace a newer WS stop with an older HTTP snapshot", async () => {
    let resolve!: (value: Awaited<ReturnType<typeof getMusicState>>) => void;
    const stale = song();
    vi.mocked(getMusicState).mockReturnValue(new Promise((done) => { resolve = done; }));
    render(<MusicBotPanel channelId="a" />);
    act(() => useVoiceStore.getState().setMusicBotState("a", song({ is_active: false, current_track: null })));
    await act(async () => resolve({ success: true, data: stale }));
    expect(screen.queryByText("A song")).not.toBeInTheDocument();
    expect(useVoiceStore.getState().musicBotStates.a.is_active).toBe(false);
  });

  it("clears stale bot state when the server reports no active bot", async () => {
    vi.mocked(getMusicState).mockResolvedValue({ success: true });
    render(<MusicBotPanel channelId="a" />);
    await waitFor(() => expect(useVoiceStore.getState().musicBotStates.a).toBeUndefined());
    expect(screen.queryByText("A song")).not.toBeInTheDocument();
  });

  it("does not restore a previously unseen channel after account reset", async () => {
    useVoiceStore.setState({ musicBotStates: {}, musicBotRevisions: {}, musicBotUpdatedAt: {} });
    let resolve!: (value: Awaited<ReturnType<typeof getMusicState>>) => void;
    vi.mocked(getMusicState).mockReturnValue(new Promise((done) => { resolve = done; }));
    render(<MusicBotPanel channelId="a" />);
    act(() => useVoiceStore.getState().resetMusicBotStates());
    await act(async () => resolve({ success: true, data: song() }));
    expect(useVoiceStore.getState().musicBotStates).toEqual({});
    expect(screen.queryByText("A song")).not.toBeInTheDocument();
  });

  it("does not accept a mismatched server snapshot and offers retry", async () => {
    vi.mocked(getMusicState).mockResolvedValue({ success: true, data: song({ server_id: "wrong" }) });
    render(<MusicBotPanel channelId="a" />);
    await screen.findByText("stateError");
    vi.mocked(getMusicState).mockResolvedValue({ success: true });
    fireEvent.click(screen.getByRole("button", { name: "retry" }));
    await waitFor(() => expect(screen.queryByText("stateError")).not.toBeInTheDocument());
  });

  it("contains rejected controls and blocks concurrent clicks", async () => {
    let reject!: (reason: Error) => void;
    vi.mocked(pauseMusic).mockReturnValue(new Promise((_resolve, fail) => { reject = fail; }));
    render(<MusicBotPanel channelId="a" />);
    await screen.findByText("0:30");
    fireEvent.click(screen.getByRole("button", { name: "pause" }));
    fireEvent.click(screen.getByRole("button", { name: "skip" }));
    expect(skipMusic).not.toHaveBeenCalled();
    await act(async () => reject(new Error("network")));
    expect(fixture.toast).toHaveBeenCalledWith("error", "controlError");
    expect(screen.getByRole("button", { name: "skip" })).toBeEnabled();
  });

  it("keeps paused time and distinguishes buffering from playing", async () => {
    useVoiceStore.getState().setMusicBotState("a", song({ is_paused: true, elapsed_seconds: 45 }));
    render(<MusicBotPanel channelId="a" />);
    await screen.findByText("0:45");
    expect(screen.getByText("paused")).toBeInTheDocument();
    act(() => useVoiceStore.getState().setMusicBotState("a", song({ started_at: null, elapsed_seconds: 0 })));
    await screen.findByText("0:00");
    expect(screen.getByText("buffering")).toBeInTheDocument();
  });

  it("resyncs after reconnect and removes its listeners on unmount", async () => {
    const { unmount } = render(<MusicBotPanel channelId="a" />);
    await screen.findByText("0:30");
    const callback = fixture.room.on.mock.calls.find(([event]) => event === RoomEvent.Reconnected)?.[1];
    await act(async () => callback());
    expect(getMusicState).toHaveBeenCalledTimes(2);
    unmount();
    expect(fixture.room.off).toHaveBeenCalledWith(RoomEvent.Reconnected, callback);
  });

  it("ignores a response after the voice session changes", async () => {
    let resolve!: (value: Awaited<ReturnType<typeof getMusicState>>) => void;
    vi.mocked(getMusicState).mockReturnValue(new Promise((done) => { resolve = done; }));
    render(<MusicBotPanel channelId="a" />);
    act(() => useVoiceStore.setState({ currentVoiceChannelId: "b", currentVoiceServerId: "server-b" }));
    await act(async () => resolve({ success: true, data: song({ is_paused: true }) }));
    expect(useVoiceStore.getState().musicBotStates.a.is_paused).toBe(false);
    expect(screen.queryByText("A song")).not.toBeInTheDocument();
  });
});
