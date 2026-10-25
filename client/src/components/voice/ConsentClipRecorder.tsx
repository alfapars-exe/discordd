import { useCallback, useEffect, useRef, useState } from "react";
import { useRoomContext } from "@livekit/components-react";
import { Track } from "livekit-client";
import { useTranslation } from "react-i18next";
import { getClipConsent, startClipRecording, stopClipRecording } from "../../api/clipRecording";
import { useVoiceStore } from "../../stores/voiceStore";
import { useToastStore } from "../../stores/toastStore";

type ActiveRecording = {
  id: string;
  startedAt: number;
  recorder: MediaRecorder;
  context: AudioContext;
  destination: MediaStreamAudioDestinationNode;
  sources: MediaStreamAudioSourceNode[];
  chunks: Blob[];
  poll: ReturnType<typeof setInterval>;
};

function supportedMimeType(): string | undefined {
  for (const type of ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"]) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return undefined;
}

export default function ConsentClipRecorder() {
  const { t } = useTranslation("voice");
  const room = useRoomContext();
  const serverId = useVoiceStore((s) => s.currentVoiceServerId);
  const channelId = useVoiceStore((s) => s.currentVoiceChannelId);
  const [recording, setRecording] = useState(false);
  const [clipUrl, setClipUrl] = useState<string | null>(null);
  const [excludedCount, setExcludedCount] = useState(0);
  const active = useRef<ActiveRecording | null>(null);

  const applyConsent = useCallback((included: Set<string>) => {
    const current = active.current;
    if (!current) return;
    for (const source of current.sources) source.disconnect();
    current.sources = [];
    const connectTrack = (identity: string, mediaTrack?: MediaStreamTrack) => {
      if (!included.has(identity) || !mediaTrack || mediaTrack.readyState !== "live") return;
      const source = current.context.createMediaStreamSource(new MediaStream([mediaTrack]));
      source.connect(current.destination);
      current.sources.push(source);
    };
    for (const publication of room.localParticipant.audioTrackPublications.values()) {
      if (publication.source === Track.Source.Microphone) connectTrack(room.localParticipant.identity, publication.track?.mediaStreamTrack);
    }
    for (const participant of room.remoteParticipants.values()) {
      for (const publication of participant.audioTrackPublications.values()) {
        if (publication.source === Track.Source.Microphone) connectTrack(participant.identity, publication.track?.mediaStreamTrack);
      }
    }
  }, [room]);

  const refreshConsent = useCallback(async () => {
    if (!serverId || !channelId || !active.current) return;
    const response = await getClipConsent(serverId, channelId);
    if (!response.success || !response.data) return;
    setExcludedCount(response.data.excluded_user_ids.length);
    applyConsent(new Set(response.data.included_user_ids));
  }, [applyConsent, channelId, serverId]);

  const stop = useCallback(async () => {
    const current = active.current;
    if (!current || !serverId || !channelId) return;
    clearInterval(current.poll);
    const duration = performance.now() - current.startedAt;
    const stopped = new Promise<Blob>((resolve) => {
      current.recorder.addEventListener("stop", () => resolve(new Blob(current.chunks, { type: current.recorder.mimeType || "audio/webm" })), { once: true });
    });
    current.recorder.stop();
    const blob = await stopped;
    for (const source of current.sources) source.disconnect();
    await current.context.close();
    active.current = null;
    setRecording(false);
    setClipUrl((previous) => {
      if (previous) URL.revokeObjectURL(previous);
      return URL.createObjectURL(blob);
    });
    await stopClipRecording(serverId, channelId, current.id, duration);
  }, [channelId, serverId]);

  const start = useCallback(async () => {
    if (!serverId || !channelId || typeof MediaRecorder === "undefined") return;
    const response = await startClipRecording(serverId, channelId);
    if (!response.success || !response.data?.recording_id) {
      useToastStore.getState().addToast("error", t("clipRecordingStartFailed"));
      return;
    }
    const context = new AudioContext();
    const destination = context.createMediaStreamDestination();
    const chunks: Blob[] = [];
    const mimeType = supportedMimeType();
    const recorder = new MediaRecorder(destination.stream, mimeType ? { mimeType } : undefined);
    const session: ActiveRecording = {
      id: response.data.recording_id,
      startedAt: performance.now(), recorder, context, destination, chunks, sources: [],
      poll: setInterval(() => void refreshConsent(), 2000),
    };
    recorder.addEventListener("dataavailable", (event) => { if (event.data.size > 0) chunks.push(event.data); });
    active.current = session;
    setExcludedCount(response.data.excluded_user_ids.length);
    applyConsent(new Set(response.data.included_user_ids));
    recorder.start(1000);
    setRecording(true);
  }, [applyConsent, channelId, refreshConsent, serverId, t]);

  useEffect(() => () => {
    const current = active.current;
    if (current) {
      clearInterval(current.poll);
      if (current.recorder.state !== "inactive") current.recorder.stop();
      for (const source of current.sources) source.disconnect();
      void current.context.close();
      active.current = null;
    }
    if (clipUrl) URL.revokeObjectURL(clipUrl);
  }, [clipUrl]);

  return (
    <div className="voice-clip-recorder">
      <button type="button" className={`settings-btn${recording ? " danger" : ""}`} onClick={() => void (recording ? stop() : start())}>
        {t(recording ? "clipRecordingStop" : "clipRecordingStart")}
      </button>
      {recording && <span role="status">{t("clipRecordingActive", { count: excludedCount })}</span>}
      {clipUrl && <div className="voice-clip-result"><audio controls src={clipUrl} /><a className="settings-btn" href={clipUrl} download={`hichat-clip-${Date.now()}.webm`}>{t("clipRecordingDownload")}</a></div>}
    </div>
  );
}
