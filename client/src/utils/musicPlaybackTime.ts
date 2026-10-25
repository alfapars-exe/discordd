import type { MusicBotChannelState } from "../types/music";

export type MusicTimeline = { key: string; elapsed: number; anchoredAt: number; paused: boolean };

export function musicTrackKey(state: MusicBotChannelState): string {
  return `${state.channel_id}:${state.current_track?.video_id ?? ""}:${state.started_at ?? ""}`;
}

/** Server position wins. The legacy fallback preserves locally observed pause
 * time, but cannot reconstruct pauses that happened before this client joined. */
export function advanceMusicTimeline(previous: MusicTimeline | null, state: MusicBotChannelState, receivedAt: number): MusicTimeline {
  const key = musicTrackKey(state);
  const started = state.started_at ? Date.parse(state.started_at) : NaN;
  let elapsed = typeof state.elapsed_seconds === "number" && Number.isFinite(state.elapsed_seconds)
    ? Math.max(0, state.elapsed_seconds)
    : previous?.key === key
      ? musicElapsedAt(previous, receivedAt)
      : Number.isFinite(started) ? Math.max(0, (receivedAt - started) / 1000) : 0;
  if (!state.current_track) elapsed = 0;
  return { key, elapsed, anchoredAt: receivedAt, paused: state.is_paused || !state.started_at || !state.current_track || !state.is_active };
}

export function musicElapsedAt(timeline: MusicTimeline, now: number): number {
  return Math.max(0, timeline.elapsed + (timeline.paused ? 0 : Math.max(0, now - timeline.anchoredAt) / 1000));
}
