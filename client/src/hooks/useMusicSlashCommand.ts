/**
 * useMusicSlashCommand — Discord-style slash commands for the music bot.
 *
 * Handles `/play <url>`, `/skip`, `/pause`, `/resume`, `/stop` typed in any
 * channel's chat input. Recognized commands never become chat messages.
 * The outcome lets the composer retain rejected commands for correction.
 *
 * Permissions are enforced server-side; here we just translate text →
 * HTTP call and toast the outcome.
 *
 * Unexpected failures are surfaced with localized copy, never provider text.
 */

import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useVoiceStore } from "../stores/voiceStore";
import { useToastStore } from "../stores/toastStore";
import { showMusicRequestError } from "../utils/musicRequestError";
import { playMusic, searchMusic, skipMusic, pauseMusic, resumeMusic, stopMusic } from "../api/music";

const MUSIC_COMMANDS = new Set(["play", "skip", "pause", "resume", "stop"]);

export type MusicCommandResult =
  | { handled: false }
  | { handled: true; outcome: "success" | "failed" | "pending" };

export function useMusicSlashCommand() {
  const { t } = useTranslation("music");
  const addToast = useToastStore((s) => s.addToast);

  return useCallback(
    async (text: string): Promise<MusicCommandResult> => {
      // Pasted commands can separate their arguments with a tab or newline.
      const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim());
      const cmd = match?.[1]?.toLowerCase();
      if (!cmd || !MUSIC_COMMANDS.has(cmd)) return { handled: false };
      const arg = match?.[2]?.trim() ?? "";

      const { currentVoiceChannelId: voiceChannelId, currentVoiceServerId: serverId } = useVoiceStore.getState();
      if (!serverId || !voiceChannelId) {
        addToast("error", t("notInVoice"));
        return { handled: true, outcome: "failed" };
      }

      try {
        if (cmd === "play") {
          if (!arg) {
            addToast("error", t("invalidYouTubeUrl"));
            return { handled: true, outcome: "failed" };
          }
          // Resolution + queue insert can take 30+ s for playlists on
          // cpu-basic HF tier; keep the user informed.
          addToast("info", t("addingTrack"));
          let target = arg;
          if (!/^https?:\/\//i.test(arg)) {
            const search = await searchMusic(serverId, voiceChannelId, arg);
            const first = search.data?.results?.[0];
            if (!search.success || !first) {
              showMusicRequestError(search, "play");
              return { handled: true, outcome: search.isTimeout ? "pending" : "failed" };
            }
            target = first.url;
          }
          const res = await playMusic(serverId, voiceChannelId, target);
          if (res.success) {
            const tracks = res.data?.added_tracks;
            if (!Array.isArray(tracks) || tracks.length === 0) {
              addToast("error", t("playError"));
              return { handled: true, outcome: "failed" };
            }
            addToast("success", t("addedToQueue", { count: tracks.length }));
            return { handled: true, outcome: "success" };
          }
          showMusicRequestError(res, "play");
          // A timed-out POST may have succeeded. Preserve the draft without
          // automatic retry; the toast asks users to check the queue first.
          return { handled: true, outcome: res.isTimeout ? "pending" : "failed" };
        }

        const fn =
          cmd === "skip" ? skipMusic :
          cmd === "pause" ? pauseMusic :
          cmd === "resume" ? resumeMusic :
          stopMusic;
        const res = await fn(serverId, voiceChannelId);
        if (!res.success) {
          showMusicRequestError(res, "control");
          return { handled: true, outcome: res.isTimeout ? "pending" : "failed" };
        }
        const successKey =
          cmd === "skip" ? "commandSkipped" :
          cmd === "pause" ? "commandPaused" :
          cmd === "resume" ? "commandResumed" :
          "commandStopped";
        addToast("success", t(successKey));
        return { handled: true, outcome: "success" };
      } catch {
        // Unexpected errors can contain internal provider text; never render it.
        addToast("error", t(cmd === "play" ? "playError" : "controlError"));
        return { handled: true, outcome: "failed" };
      }
    },
    [addToast, t],
  );
}
