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
import type { PlayMusicResponse, MusicBotChannelState } from "../types";

export async function playMusic(serverId: string, channelId: string, url: string) {
  return apiClient<PlayMusicResponse>(
    `/servers/${serverId}/channels/${channelId}/music/play`,
    { method: "POST", body: { url } },
  );
}

export async function skipMusic(serverId: string, channelId: string) {
  return apiClient<{ status: string }>(
    `/servers/${serverId}/channels/${channelId}/music/skip`,
    { method: "POST" },
  );
}

export async function pauseMusic(serverId: string, channelId: string) {
  return apiClient<{ status: string }>(
    `/servers/${serverId}/channels/${channelId}/music/pause`,
    { method: "POST" },
  );
}

export async function resumeMusic(serverId: string, channelId: string) {
  return apiClient<{ status: string }>(
    `/servers/${serverId}/channels/${channelId}/music/resume`,
    { method: "POST" },
  );
}

export async function stopMusic(serverId: string, channelId: string) {
  return apiClient<{ status: string }>(
    `/servers/${serverId}/channels/${channelId}/music/stop`,
    { method: "POST" },
  );
}

/**
 * Initial-load fetch for the panel. Returns null on 404 (no active bot).
 * Real-time deltas come via the WebSocket — this is for first paint and
 * reconnect resync.
 */
export async function getMusicState(serverId: string, channelId: string) {
  return apiClient<MusicBotChannelState>(
    `/servers/${serverId}/channels/${channelId}/music/state`,
  );
}
