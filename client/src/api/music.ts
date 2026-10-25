/**
 * Music bot API — per-channel YouTube playback control.
 *
 * Backend routes match `server/handlers/music.go`. Permission gating happens
 * server-side: play/skip/pause/resume need PermSpeak in the channel,
 * stop needs PermManageChannels. Frontend just calls — toast on error.
 *
 * Real-time state updates arrive via the `music_bot_state` WebSocket opcode
 * (handled in hooks/ws/voiceEventHandlers.ts). These functions are for
 * triggering changes; subscribers see the result through the WS push.
 */

import { apiClient } from "./client";
import type { PlayMusicResponse, SearchMusicResponse, MusicBotChannelState } from "../types";

// Bounded control/state requests must release the UI lock on dead connections.
const CONTROL_TIMEOUT_MS = 15_000;

/**
 * The server extends this request's write deadline to 45 s (YouTube
 * extraction + LiveKit connect can outlast the global 15 s WriteTimeout);
 * 50 s leaves headroom for the response to arrive. On expiry the call
 * resolves with `isTimeout: true` — the server may still have queued the
 * track, so callers must not report that as a hard failure.
 */
export async function playMusic(serverId: string, channelId: string, url: string) {
  return apiClient<PlayMusicResponse>(
    `/servers/${serverId}/channels/${channelId}/music/play`,
    { method: "POST", body: { url }, timeoutMs: 50_000 },
  );
}

export async function searchMusic(serverId: string, channelId: string, query: string) {
  return apiClient<SearchMusicResponse>(
    `/servers/${serverId}/channels/${channelId}/music/search?q=${encodeURIComponent(query)}`,
    { timeoutMs: 25_000 },
  );
}

export async function skipMusic(serverId: string, channelId: string) {
  return apiClient<{ status: string }>(
    `/servers/${serverId}/channels/${channelId}/music/skip`,
    { method: "POST", timeoutMs: CONTROL_TIMEOUT_MS },
  );
}

export async function pauseMusic(serverId: string, channelId: string) {
  return apiClient<{ status: string }>(
    `/servers/${serverId}/channels/${channelId}/music/pause`,
    { method: "POST", timeoutMs: CONTROL_TIMEOUT_MS },
  );
}

export async function resumeMusic(serverId: string, channelId: string) {
  return apiClient<{ status: string }>(
    `/servers/${serverId}/channels/${channelId}/music/resume`,
    { method: "POST", timeoutMs: CONTROL_TIMEOUT_MS },
  );
}

export async function stopMusic(serverId: string, channelId: string) {
  return apiClient<{ status: string }>(
    `/servers/${serverId}/channels/${channelId}/music/stop`,
    { method: "POST", timeoutMs: CONTROL_TIMEOUT_MS },
  );
}

/**
 * Initial-load fetch for the panel. When no bot is active the server still
 * responds 200 success=true but omits `data` — treat an absent `res.data`
 * as "no music playing" (the panel already does, via `!res.data` guard).
 * Real-time deltas come via the WebSocket — this is for first paint and
 * reconnect resync.
 */
export async function getMusicState(serverId: string, channelId: string) {
  return apiClient<MusicBotChannelState>(
    `/servers/${serverId}/channels/${channelId}/music/state`,
    { timeoutMs: CONTROL_TIMEOUT_MS },
  );
}

export async function removeMusicQueueItem(serverId: string, channelId: string, queueItemId: string, revision: number) {
  return apiClient<{ status: string }>(
    `/servers/${serverId}/channels/${channelId}/music/queue/${encodeURIComponent(queueItemId)}?revision=${revision}`,
    { method: "DELETE", timeoutMs: CONTROL_TIMEOUT_MS },
  );
}

export async function reorderMusicQueue(serverId: string, channelId: string, queueItemIds: string[], expectedRevision: number) {
  return apiClient<{ status: string }>(
    `/servers/${serverId}/channels/${channelId}/music/queue`,
    { method: "PUT", body: { queue_item_ids: queueItemIds, expected_revision: expectedRevision }, timeoutMs: CONTROL_TIMEOUT_MS },
  );
}

export async function shuffleMusicQueue(serverId: string, channelId: string, expectedRevision: number) {
  return apiClient<{ status: string }>(
    `/servers/${serverId}/channels/${channelId}/music/shuffle`,
    { method: "POST", body: { expected_revision: expectedRevision }, timeoutMs: CONTROL_TIMEOUT_MS },
  );
}

export async function setMusicRepeatMode(serverId: string, channelId: string, mode: "off" | "one" | "all") {
  return apiClient<{ status: string }>(
    `/servers/${serverId}/channels/${channelId}/music/repeat`,
    { method: "PUT", body: { mode }, timeoutMs: CONTROL_TIMEOUT_MS },
  );
}

export async function seekMusic(serverId: string, channelId: string, seconds: number) {
  return apiClient<{ status: string }>(
    `/servers/${serverId}/channels/${channelId}/music/seek`,
    { method: "POST", body: { seconds: Math.floor(seconds) }, timeoutMs: CONTROL_TIMEOUT_MS },
  );
}

export async function restoreMusicSession(serverId: string, channelId: string) {
  return apiClient<{ status: string }>(
    `/servers/${serverId}/channels/${channelId}/music/restore`,
    { method: "POST", timeoutMs: CONTROL_TIMEOUT_MS },
  );
}
