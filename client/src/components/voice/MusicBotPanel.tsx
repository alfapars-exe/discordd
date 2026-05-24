/**
 * MusicBotPanel — Per-channel music bot UI tile.
 *
 * Shows now-playing artwork + title + artist, progress bar, the next 3
 * queued tracks, and play/pause/skip/stop controls. Renders only when
 * the channel actually has an active bot (musicBotStates[channelId]
 * exists with is_active=true and a current track).
 *
 * State source: voiceStore.musicBotStates (kept in sync by the
 * `music_bot_state` WebSocket handler in voiceEventHandlers.ts).
 *
 * Permissions are enforced server-side. We render all buttons regardless;
 * the API call returns 403 → toast → no-op. Mirrors how mic mute / channel
 * mute already behave.
 */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useVoiceStore } from "../../stores/voiceStore";
import { useServerStore } from "../../stores/serverStore";
import { useToastStore } from "../../stores/toastStore";
import { skipMusic, pauseMusic, resumeMusic, stopMusic, getMusicState } from "../../api/music";

type MusicBotPanelProps = {
  channelId: string;
};

function formatDuration(seconds: number): string {
  if (seconds <= 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function MusicBotPanel({ channelId }: MusicBotPanelProps) {
  const { t } = useTranslation("music");
  const state = useVoiceStore((s) => s.musicBotStates[channelId]);
  const setMusicBotState = useVoiceStore((s) => s.setMusicBotState);
  const serverId = useServerStore((s) => s.activeServerId);
  const addToast = useToastStore((s) => s.addToast);

  const [elapsed, setElapsed] = useState(0);

  // Initial fetch for first paint / reconnect resync. WS pushes drive subsequent updates.
  useEffect(() => {
    if (!serverId || !channelId) return;
    let cancelled = false;
    getMusicState(serverId, channelId)
      .then((res) => {
        if (cancelled || !res.success || !res.data) return;
        setMusicBotState(channelId, res.data);
      })
      .catch(() => {
        // 404 is normal when no bot is active yet — silent.
      });
    return () => {
      cancelled = true;
    };
  }, [serverId, channelId, setMusicBotState]);

  // Tick elapsed time every second when actively playing.
  useEffect(() => {
    if (!state?.current_track || state.is_paused || !state.started_at) {
      setElapsed(0);
      return;
    }
    const startMs = new Date(state.started_at).getTime();
    const tick = () => setElapsed(Math.max(0, Math.floor((Date.now() - startMs) / 1000)));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [state?.current_track, state?.is_paused, state?.started_at]);

  if (!state?.is_active || !serverId) return null;

  // Bot is in the room but hasn't started a track yet — show a buffering tile
  // instead of nothing so the user knows the bot is alive and connecting.
  // Without this, /play would seem to do nothing until the first sample
  // arrives (sometimes 5-10 s on cpu-basic HF tier while yt-dlp resolves).
  if (!state.current_track) {
    return (
      <div className="music-bot-panel">
        <div className="music-bot-now">
          <div className="music-bot-thumb music-bot-thumb-empty" aria-hidden>♪</div>
          <div className="music-bot-now-meta">
            <div className="music-bot-now-label">{t("buffering")}</div>
            <div className="music-bot-title">{t("connecting")}</div>
          </div>
          <div className="music-bot-controls">
            <button
              className="music-bot-btn music-bot-btn-danger"
              onClick={handleStop}
              title={t("stop")}
              aria-label={t("stop")}
            >
              ⏹
            </button>
          </div>
        </div>
      </div>
    );
  }

  const { current_track: track, queue, is_paused } = state;
  const total = track.duration_seconds || 0;
  const pct = total > 0 ? Math.min(100, (elapsed / total) * 100) : 0;

  async function handleToggle() {
    if (!serverId) return;
    const fn = is_paused ? resumeMusic : pauseMusic;
    const res = await fn(serverId, channelId);
    if (!res.success) addToast("error", res.error ?? t("controlError"));
  }

  async function handleSkip() {
    if (!serverId) return;
    const res = await skipMusic(serverId, channelId);
    if (!res.success) addToast("error", res.error ?? t("controlError"));
  }

  async function handleStop() {
    if (!serverId) return;
    const res = await stopMusic(serverId, channelId);
    if (!res.success) addToast("error", res.error ?? t("controlError"));
  }

  return (
    <div className="music-bot-panel">
      <div className="music-bot-now">
        {track.thumbnail && (
          <img src={track.thumbnail} alt="" className="music-bot-thumb" loading="lazy" />
        )}
        <div className="music-bot-now-meta">
          <div className="music-bot-now-label">{t("nowPlaying")}</div>
          <div className="music-bot-title" title={track.title}>{track.title}</div>
          {track.artist && <div className="music-bot-artist">{track.artist}</div>}
          <div className="music-bot-progress" aria-hidden>
            <div className="music-bot-progress-fill" style={{ width: `${pct}%` }} />
          </div>
          <div className="music-bot-times">
            <span>{formatDuration(elapsed)}</span>
            <span>{formatDuration(total)}</span>
          </div>
        </div>
        <div className="music-bot-controls">
          <button
            className="music-bot-btn"
            onClick={handleToggle}
            title={is_paused ? t("resume") : t("pause")}
            aria-label={is_paused ? t("resume") : t("pause")}
          >
            {is_paused ? "▶" : "⏸"}
          </button>
          <button
            className="music-bot-btn"
            onClick={handleSkip}
            title={t("skip")}
            aria-label={t("skip")}
          >
            ⏭
          </button>
          <button
            className="music-bot-btn music-bot-btn-danger"
            onClick={handleStop}
            title={t("stop")}
            aria-label={t("stop")}
          >
            ⏹
          </button>
        </div>
      </div>

      {queue.length > 0 && (
        <div className="music-bot-queue">
          <div className="music-bot-queue-label">
            {t("upNext", { count: queue.length })}
          </div>
          <ul className="music-bot-queue-list">
            {queue.slice(0, 3).map((q, i) => (
              <li key={`${q.video_id}-${i}`} className="music-bot-queue-item">
                <span className="music-bot-queue-pos">{i + 1}.</span>
                <span className="music-bot-queue-title" title={q.title}>{q.title}</span>
                <span className="music-bot-queue-dur">{formatDuration(q.duration_seconds)}</span>
              </li>
            ))}
            {queue.length > 3 && (
              <li className="music-bot-queue-more">{t("plusMore", { count: queue.length - 3 })}</li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}

export default MusicBotPanel;
