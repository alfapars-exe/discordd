/**
 * useMusicSlashCommand — Discord-style slash commands for the music bot.
 *
 * Handles `/play <url>`, `/skip`, `/pause`, `/resume`, `/stop` typed in any
 * channel's chat input. Returns true if the input matched a known music
 * command (regardless of API success/failure) — caller skips the normal
 * "send as chat message" flow when true.
 *
 * Permissions are enforced server-side; here we just translate text →
 * HTTP call and toast the outcome.
 *
 * Defensive contract: this function never throws. Any unexpected error
 * from the API client is caught here and surfaced as an error toast,
 * because callers (MessageInput.handleSend) treat a thrown promise as
 * "silent failure" — the user sees nothing happen and assumes the
 * client froze. console.warn at command-parse time + console.error in
 * the catch path leave a paper trail for the next debug pass.
 */

import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useVoiceStore } from "../stores/voiceStore";
import { useServerStore } from "../stores/serverStore";
import { useToastStore } from "../stores/toastStore";
import { showApiError } from "../utils/apiError";
import { playMusic, skipMusic, pauseMusic, resumeMusic, stopMusic } from "../api/music";

const MUSIC_COMMANDS = new Set(["play", "skip", "pause", "resume", "stop"]);

export function useMusicSlashCommand() {
  const { t } = useTranslation("music");
  const addToast = useToastStore((s) => s.addToast);

  return useCallback(
    async (text: string): Promise<boolean> => {
      const trimmed = text.trim();
      if (!trimmed.startsWith("/")) return false;

      const space = trimmed.indexOf(" ");
      const cmd = (space === -1 ? trimmed.slice(1) : trimmed.slice(1, space)).toLowerCase();
      const arg = space === -1 ? "" : trimmed.slice(space + 1).trim();

      if (!MUSIC_COMMANDS.has(cmd)) return false;

      // Lifecycle log: persists into devtools history so the next user
      // bug report ("/play does nothing") can be triaged in seconds.
      console.warn("[music] slash command:", cmd, "argLen:", arg.length);

      const voiceChannelId = useVoiceStore.getState().currentVoiceChannelId;
      const serverId = useServerStore.getState().activeServerId;
      if (!serverId || !voiceChannelId) {
        addToast("error", t("notInVoice"));
        return true;
      }

      try {
        if (cmd === "play") {
          if (!arg) {
            addToast("error", t("invalidYouTubeUrl"));
            return true;
          }
          // Resolution + queue insert can take 30+ s for playlists on
          // cpu-basic HF tier; keep the user informed.
          addToast("info", t("addingTrack"));
          const res = await playMusic(serverId, voiceChannelId, arg);
          // Log full response so silent failures (network glitch, server
          // panic, success:false with empty error) leave a paper trail.
          console.warn("[music] playMusic response:", res);
          if (res.success && res.data) {
            const count = res.data.added_tracks.length;
            addToast("success", t("addedToQueue", { count }));
          } else {
            showApiError(res, { fallbackKey: "music:playError" });
          }
          return true;
        }

        const fn =
          cmd === "skip" ? skipMusic :
          cmd === "pause" ? pauseMusic :
          cmd === "resume" ? resumeMusic :
          stopMusic;
        const res = await fn(serverId, voiceChannelId);
        if (!res.success) {
          showApiError(res, { fallbackKey: "music:controlError" });
        }
        return true;
      } catch (err) {
        // Network failure, JSON parse error, anything below the apiClient
        // contract. Log + toast so the user always gets feedback even
        // when something blows up unexpectedly.
        console.error("[music] slash command failed:", cmd, err);
        const message = err instanceof Error ? err.message : t("controlError");
        addToast("error", message);
        return true;
      }
    },
    [addToast, t],
  );
}
