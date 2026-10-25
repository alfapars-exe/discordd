import { describe, expect, it } from "vitest";
import type { MusicBotChannelState } from "../types/music";
import { advanceMusicTimeline, musicElapsedAt } from "./musicPlaybackTime";

const state: MusicBotChannelState = { channel_id: "a", server_id: "s", is_active: true, is_paused: false, queue: [],
  started_at: new Date(0).toISOString(), current_track: { video_id: "v", title: "Song", duration_seconds: 180, url: "https://youtube.com/watch?v=v", requested_by_user_id: "u", requested_by_name: "User" } };

describe("music playback clock", () => {
  it("uses emitted audio time rather than extraction/wall-clock time", () => {
    const timeline = advanceMusicTimeline(null, { ...state, elapsed_seconds: 12 }, 100_000);
    expect(musicElapsedAt(timeline, 103_000)).toBe(15);
  });
  it("freezes during pause and resumes without adding paused time", () => {
    const playing = advanceMusicTimeline(null, { ...state, elapsed_seconds: 12 }, 100_000);
    const paused = advanceMusicTimeline(playing, { ...state, is_paused: true, elapsed_seconds: 15 }, 103_000);
    expect(musicElapsedAt(paused, 200_000)).toBe(15);
    const resumed = advanceMusicTimeline(paused, { ...state, elapsed_seconds: 15 }, 200_000);
    expect(musicElapsedAt(resumed, 202_000)).toBe(17);
  });
  it("does not advance before the first audio sample", () => {
    const buffered = advanceMusicTimeline(null, { ...state, started_at: null, elapsed_seconds: 0 }, 100_000);
    expect(musicElapsedAt(buffered, 200_000)).toBe(0);
  });
  it("preserves locally observed pauses for started_at-only older servers", () => {
    const playing = advanceMusicTimeline(null, state, 10_000);
    const paused = advanceMusicTimeline(playing, { ...state, is_paused: true }, 12_000);
    const resumed = advanceMusicTimeline(paused, state, 25_000);
    expect(musicElapsedAt(resumed, 28_000)).toBe(15);
  });
  it("resets for the next track and tolerates an invalid old timestamp", () => {
    const first = advanceMusicTimeline(null, state, 50_000);
    const next = advanceMusicTimeline(first, { ...state, started_at: "invalid", current_track: { ...state.current_track!, video_id: "next" } }, 60_000);
    expect(next.elapsed).toBe(0);
  });
});
