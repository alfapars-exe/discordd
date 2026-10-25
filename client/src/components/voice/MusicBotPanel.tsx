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

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useRoomContext } from "@livekit/components-react";
import { RoomEvent } from "livekit-client";
import { useVoiceStore } from "../../stores/voiceStore";
import { useToastStore } from "../../stores/toastStore";
import { showMusicRequestError } from "../../utils/musicRequestError";
import { advanceMusicTimeline, musicElapsedAt, musicTrackKey, type MusicTimeline } from "../../utils/musicPlaybackTime";
import { skipMusic, pauseMusic, resumeMusic, stopMusic, getMusicState, playMusic, searchMusic, removeMusicQueueItem, reorderMusicQueue, shuffleMusicQueue, setMusicRepeatMode, restoreMusicSession, seekMusic } from "../../api/music";
import type { MusicTrack } from "../../types";

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
  const updatedAt = useVoiceStore((s) => s.musicBotUpdatedAt[channelId]);
  const serverId = useVoiceStore((s) => s.currentVoiceChannelId === channelId ? s.currentVoiceServerId : null);
  const room = useRoomContext();
  const musicBotIdentity = `__music_bot__:${channelId}`;
  const musicVolume = useVoiceStore((s) => s.userVolumes[musicBotIdentity] ?? 100);
  const setUserVolume = useVoiceStore((s) => s.setUserVolume);

  const [timeline, setTimeline] = useState<MusicTimeline | null>(null);
  const [now, setNow] = useState(Date.now);
  const [loadStatus, setLoadStatus] = useState<"loading" | "ready" | "error">("loading");
  const [pending, setPending] = useState(false);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<MusicTrack[]>([]);
  const [seekDraft, setSeekDraft] = useState<number | null>(null);
  const dragItem = useRef<string | null>(null);
  const actionGeneration = useRef(0);
  const actionPending = useRef(false);
  const refreshRef = useRef<(() => void) | null>(null);

  const invalidateActions = useCallback(() => {
    ++actionGeneration.current;
    actionPending.current = false;
  }, []);

  // REST repairs missed WS updates on reconnect/focus and periodically. A REST
  // response may not overwrite a more recent WS snapshot (including a stop).
  useEffect(() => {
    if (!serverId || !channelId) return;
    let cancelled = false;
    let request = 0;
    const ownsSession = () => {
      const voice = useVoiceStore.getState();
      return !cancelled && voice.currentVoiceChannelId === channelId && voice.currentVoiceServerId === serverId;
    };
    async function refresh() {
      const sequence = ++request;
      const before = useVoiceStore.getState();
      const revision = before.musicBotRevisions[channelId] ?? 0;
      const resetRevision = before.musicBotResetRevision;
      try {
        const res = await getMusicState(serverId!, channelId);
        if (!ownsSession() || sequence !== request) return;
        const voice = useVoiceStore.getState();
        if (voice.musicBotResetRevision !== resetRevision || (voice.musicBotRevisions[channelId] ?? 0) !== revision) {
          setLoadStatus("ready");
          return;
        }
        if (!res.success || (res.data && (res.data.channel_id !== channelId || res.data.server_id !== serverId))) {
          setLoadStatus("error");
          return;
        }
        if (res.data) voice.setMusicBotState(channelId, res.data);
        else voice.clearMusicBotState(channelId);
        setLoadStatus("ready");
      } catch {
        if (ownsSession() && sequence === request) setLoadStatus("error");
      }
    }
    refreshRef.current = refresh;
    queueMicrotask(() => {
      if (ownsSession()) { setPending(false); setLoadStatus("loading"); }
    });
    void refresh();
    room.on(RoomEvent.Reconnected, refresh);
    window.addEventListener("online", refresh);
    window.addEventListener("focus", refresh);
    const timer = window.setInterval(refresh, 30_000);
    return () => {
      cancelled = true;
      invalidateActions();
      refreshRef.current = null;
      window.clearInterval(timer);
      room.off(RoomEvent.Reconnected, refresh);
      window.removeEventListener("online", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [serverId, channelId, room, invalidateActions]);

  // elapsed_seconds is the authoritative server playback clock, excluding
  // pause time. Retain compatibility with older started_at-only servers.
  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setTimeline((previous) => state ? advanceMusicTimeline(previous, state, updatedAt ?? Date.now()) : null);
      setNow(Date.now());
    });
    const timer = state?.current_track && !state.is_paused ? window.setInterval(() => setNow(Date.now()), 1000) : null;
    return () => { cancelled = true; if (timer !== null) window.clearInterval(timer); };
  }, [state, updatedAt]);

  function retry() {
    setLoadStatus("loading");
    refreshRef.current?.();
  }

  async function runSearch(event: React.FormEvent) {
    event.preventDefault();
    const value = query.trim();
    if (!serverId || !value || value.length > 100 || searching) return;
    setSearching(true);
    try {
      const response = await searchMusic(serverId, channelId, value);
      if (!response.success || !response.data) {
        showMusicRequestError(response, "play");
        return;
      }
      setResults(response.data.results ?? []);
    } catch {
      useToastStore.getState().addToast("error", t("searchError"));
    } finally {
      setSearching(false);
    }
  }

  async function addResult(track: MusicTrack) {
    if (!serverId || pending) return;
    setPending(true);
    try {
      const response = await playMusic(serverId, channelId, track.url);
      if (!response.success) showMusicRequestError(response, "play");
      else {
        useToastStore.getState().addToast("success", t("addedToQueue", { count: response.data?.added_tracks.length ?? 1 }));
        setResults((items) => items.filter((item) => item.video_id !== track.video_id));
      }
    } catch {
      useToastStore.getState().addToast("error", t("playError"));
    } finally {
      setPending(false);
    }
  }

  async function mutateQueue(action: () => Promise<{ success: boolean; isTimeout?: boolean }>) {
    if (pending) return;
    setPending(true);
    try {
      const response = await action();
      if (!response.success) showMusicRequestError(response, "control");
      else refreshRef.current?.();
    } catch {
      useToastStore.getState().addToast("error", t("queueMutationError"));
    } finally { setPending(false); }
  }

  function dropQueueItem(targetID: string) {
    const sourceID = dragItem.current;
    dragItem.current = null;
    if (!sourceID || sourceID === targetID || !serverId || state?.revision === undefined) return;
    const ids = (state.queue ?? []).map((item) => item.queue_item_id).filter((id): id is string => !!id);
    if (ids.length !== state.queue.length) return;
    const from = ids.indexOf(sourceID), to = ids.indexOf(targetID);
    if (from < 0 || to < 0) return;
    ids.splice(to, 0, ids.splice(from, 1)[0]!);
    void mutateQueue(() => reorderMusicQueue(serverId, channelId, ids, state.revision!));
  }

  function moveQueueItem(itemID: string, delta: -1 | 1) {
    if (!serverId || state?.revision === undefined) return;
    const ids = state.queue.map((item) => item.queue_item_id).filter((id): id is string => !!id);
    if (ids.length !== state.queue.length) return;
    const from = ids.indexOf(itemID), to = from + delta;
    if (from < 0 || to < 0 || to >= ids.length) return;
    [ids[from], ids[to]] = [ids[to]!, ids[from]!];
    void mutateQueue(() => reorderMusicQueue(serverId, channelId, ids, state.revision!));
  }

  const searchBox = <div className="music-bot-search">
    <form onSubmit={(event) => void runSearch(event)}>
      <input value={query} maxLength={100} onChange={(event) => setQuery(event.target.value)} placeholder={t("searchPlaceholder")} aria-label={t("searchPlaceholder")} />
      <button className="music-bot-btn" disabled={searching || !query.trim()}>{searching ? t("searching") : t("search")}</button>
    </form>
    {results.length > 0 && <ul className="music-bot-search-results">
      {results.map((result) => <li key={result.video_id}>
        <span><strong>{result.title}</strong>{result.artist && <small>{result.artist}</small>}</span>
        <button className="music-bot-btn" disabled={pending} onClick={() => void addResult(result)}>{t("add")}</button>
      </li>)}
    </ul>}
  </div>;

  if (!serverId) return null;
  const statusMessage = loadStatus === "error" ? <div role="status" className="music-bot-status">
    <span>{t("stateError")}</span><button className="music-bot-btn" onClick={retry}>{t("retry")}</button>
  </div> : null;
  if (state && !state.is_active && state.is_paused && state.server_id === serverId && state.queue.length > 0) {
    return <div className="music-bot-panel music-bot-restored" role="status">
      {searchBox}{statusMessage}
      <strong>{t("restoredTitle")}</strong>
      <p>{t("restoredDescription", { count: state.queue.length })}</p>
      <button className="music-bot-btn" disabled={pending} onClick={() => void mutateQueue(() => restoreMusicSession(serverId, channelId))} aria-label={t("restorePlayback")}>▶</button>
    </div>;
  }
  if (!state?.is_active || !state.current_track || state.server_id !== serverId) {
    return <div className="music-bot-panel">{searchBox}{statusMessage}</div>;
  }
  const { current_track: track, queue, is_paused } = state;
  const total = track.duration_seconds || 0;
  const position = timeline?.key === musicTrackKey(state) ? Math.floor(musicElapsedAt(timeline, now)) : 0;
  const elapsed = total > 0 ? Math.min(total, position) : position;
  const displayedElapsed = seekDraft ?? elapsed;
  const pct = total > 0 ? Math.min(100, (displayedElapsed / total) * 100) : 0;
  const repeatMode = state.repeat_mode || "off";
  const nextRepeatMode = repeatMode === "off" ? "one" : repeatMode === "one" ? "all" : "off";

  async function control(fn: typeof pauseMusic) {
    const voice = useVoiceStore.getState();
    if (actionPending.current || !serverId || voice.currentVoiceChannelId !== channelId || voice.currentVoiceServerId !== serverId) return;
    actionPending.current = true;
    const generation = ++actionGeneration.current;
    const resetRevision = voice.musicBotResetRevision;
    const ownsAction = () => {
      const current = useVoiceStore.getState();
      return generation === actionGeneration.current && resetRevision === current.musicBotResetRevision
        && current.currentVoiceChannelId === channelId && current.currentVoiceServerId === serverId;
    };
    setPending(true);
    try {
      const res = await fn(serverId, channelId);
      if (!ownsAction()) return;
      if (!res.success) showMusicRequestError(res, "control");
      else refreshRef.current?.();
    } catch {
      if (ownsAction()) useToastStore.getState().addToast("error", t("controlError"));
    } finally {
      if (generation === actionGeneration.current) {
        actionPending.current = false;
        setPending(false);
      }
    }
  }

  return (
    <div className="music-bot-panel">
      {searchBox}
      {statusMessage}
      <div className="music-bot-now">
        {track.thumbnail && (
          <img src={track.thumbnail} alt="" className="music-bot-thumb" loading="lazy" />
        )}
        <div className="music-bot-now-meta">
          <div className="music-bot-now-label">{t(is_paused ? "paused" : state.started_at ? "nowPlaying" : "buffering")}</div>
          <div className="music-bot-title" title={track.title}>{track.title}</div>
          {track.artist && <div className="music-bot-artist">{track.artist}</div>}
          {total > 0 ? <input
            className="music-bot-progress music-bot-seek"
            type="range"
            min={0}
            max={Math.max(0, total - 1)}
            step={1}
            value={displayedElapsed}
            disabled={pending}
            aria-label={t("seek")}
            aria-valuetext={`${formatDuration(displayedElapsed)} / ${formatDuration(total)}`}
            onChange={(event) => setSeekDraft(Number(event.currentTarget.value))}
            onPointerUp={(event) => {
              const target = Number(event.currentTarget.value);
              setSeekDraft(null);
              void mutateQueue(() => seekMusic(serverId, channelId, target));
            }}
            onKeyUp={(event) => {
              if (!["ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"].includes(event.key)) return;
              const target = Number(event.currentTarget.value);
              setSeekDraft(null);
              void mutateQueue(() => seekMusic(serverId, channelId, target));
            }}
          /> : <div className="music-bot-progress" aria-label={t("seekUnavailable")}>
            <div className="music-bot-progress-fill" style={{ width: `${pct}%` }} />
          </div>}
          <div className="music-bot-times">
            <span>{formatDuration(displayedElapsed)}</span>
            <span>{formatDuration(total)}</span>
          </div>
        </div>
        <div className="music-bot-controls">
          <button
            className="music-bot-btn"
            onClick={() => void mutateQueue(() => shuffleMusicQueue(serverId, channelId, state.revision ?? 0))}
            disabled={pending || queue.length < 2 || state.revision === undefined}
            title={t("shuffle")}
            aria-label={t("shuffle")}
          >
            🔀
          </button>
          <button
            className="music-bot-btn"
            onClick={() => void mutateQueue(() => setMusicRepeatMode(serverId, channelId, nextRepeatMode))}
            disabled={pending}
            title={t(`repeat_${repeatMode}`)}
            aria-label={t(`repeat_${repeatMode}`)}
          >
            {repeatMode === "one" ? "🔂" : "🔁"}
          </button>
          <button
            className="music-bot-btn"
            onClick={() => void control(is_paused ? resumeMusic : pauseMusic)}
            disabled={pending}
            title={is_paused ? t("resume") : t("pause")}
            aria-label={is_paused ? t("resume") : t("pause")}
          >
            {is_paused ? "▶" : "⏸"}
          </button>
          <button
            className="music-bot-btn"
            onClick={() => void control(skipMusic)}
            disabled={pending}
            title={t("skip")}
            aria-label={t("skip")}
          >
            ⏭
          </button>
          <button
            className="music-bot-btn music-bot-btn-danger"
            onClick={() => void control(stopMusic)}
            disabled={pending}
            title={t("stop")}
            aria-label={t("stop")}
          >
            ⏹
          </button>
        </div>
      </div>

      <label className="music-bot-volume">
        <span>{t("personalVolume")}</span>
        <input
          type="range"
          min={0}
          max={200}
          step={5}
          value={musicVolume}
          aria-label={t("personalVolume")}
          aria-valuetext={`${musicVolume}%`}
          onChange={(event) => setUserVolume(musicBotIdentity, Number(event.target.value))}
        />
        <span>{musicVolume}%</span>
      </label>

      {queue.length > 0 && (
        <div className="music-bot-queue">
          <div className="music-bot-queue-label">
            {t("upNext", { count: queue.length })}
          </div>
          <ul className="music-bot-queue-list">
            {queue.map((q, i) => (
              <li key={q.queue_item_id ?? `${q.video_id}-${i}`} className="music-bot-queue-item"
                draggable={!!q.queue_item_id && !pending}
                onDragStart={() => { dragItem.current = q.queue_item_id ?? null; }}
                onDragOver={(event) => event.preventDefault()}
                onDrop={() => q.queue_item_id && dropQueueItem(q.queue_item_id)}>
                <span className="music-bot-queue-pos">{i + 1}.</span>
                <span className="music-bot-queue-title" title={q.title}>{q.title}</span>
                <span className="music-bot-queue-dur">{formatDuration(q.duration_seconds)}</span>
                {q.queue_item_id && state.revision !== undefined && <>
                  <button className="music-bot-btn" disabled={pending || i === 0} aria-label={t("moveTrackUp", { title: q.title })} onClick={() => moveQueueItem(q.queue_item_id!, -1)}>↑</button>
                  <button className="music-bot-btn" disabled={pending || i === queue.length - 1} aria-label={t("moveTrackDown", { title: q.title })} onClick={() => moveQueueItem(q.queue_item_id!, 1)}>↓</button>
                </>}
                {q.queue_item_id && state.revision !== undefined && <button className="music-bot-btn" disabled={pending}
                  aria-label={t("removeTrack", { title: q.title })}
                  onClick={() => void mutateQueue(() => removeMusicQueueItem(serverId, channelId, q.queue_item_id!, state.revision!))}>×</button>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export default MusicBotPanel;
