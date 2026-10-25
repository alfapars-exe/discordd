import { useState, useEffect, useCallback, useRef, useSyncExternalStore } from "react";
import { useShallow } from "zustand/react/shallow";
import { useVoiceStore } from "../stores/voiceStore";
import { createMicrophonePipeline, type MicrophonePipeline } from "../audio/microphonePipeline";
import { captureConstraints, microphoneSettings } from "../audio/microphoneSettings";
import { getActiveCallPipeline, registerMicrophonePipeline, subscribeMicrophoneStatus } from "../audio/pipelineStatus";
import { routeAudioOutput } from "../audio/outputRouting";

/** Monitor the actual call output, or own one identical local pipeline when idle. */
export function useMicTest(): { isTesting: boolean; toggleTesting: () => void; micLevel: number; error?: string } {
  const settings = useVoiceStore(useShallow(microphoneSettings));
  const outputDevice = useVoiceStore((s) => s.outputDevice);
  const shared = useSyncExternalStore(subscribeMicrophoneStatus, getActiveCallPipeline, () => null);
  const [isTesting, setIsTesting] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const [error, setError] = useState<string>();
  const own = useRef<MicrophonePipeline | null>(null);
  const playback = useRef<HTMLAudioElement | null>(null);
  const outputRouting = useRef<{ audio: HTMLAudioElement; queue: Promise<void>; revision: number } | null>(null);
  const routePlayback = useCallback((audio: HTMLAudioElement, device: string) => {
    if (outputRouting.current?.audio !== audio) outputRouting.current = { audio, queue: Promise.resolve(), revision: 0 };
    const owner = outputRouting.current;
    const revision = ++owner.revision;
    const current = () => playback.current === audio && outputRouting.current === owner && owner.revision === revision;
    const operation = owner.queue.catch(() => {}).then(async () => {
      if (typeof audio.setSinkId === "function") {
        await routeAudioOutput(device, (sink) => audio.setSinkId(sink), { defaultSink: "", isCurrent: current });
      }
    });
    owner.queue = operation;
    return operation;
  }, []);
  const { inputDevice, micProfile } = settings;
  useEffect(() => {
    if (!isTesting) return;
    const abort = new AbortController();
    let stream: MediaStream | undefined;
    let pipeline: MicrophonePipeline | undefined;
    let audio: HTMLAudioElement | undefined;
    let unregister: (() => void) | undefined;
    let unsubscribe: (() => void) | undefined;
    const cleanup = () => {
      abort.abort();
      unsubscribe?.(); unregister?.();
      if (audio) { audio.pause(); audio.srcObject = null; }
      if (playback.current === audio) playback.current = null;
      if (pipeline) {
        if (own.current === pipeline) own.current = null;
        void pipeline.dispose();
      }
      stream?.getTracks().forEach((track) => track.stop());
    };
    void (async () => {
      let selected = shared;
      if (!selected) {
        stream = await navigator.mediaDevices.getUserMedia({ audio: captureConstraints(microphoneSettings(useVoiceStore.getState())) });
        if (abort.signal.aborted) { cleanup(); return; }
        pipeline = await createMicrophonePipeline(stream.getAudioTracks()[0], microphoneSettings(useVoiceStore.getState()), { signal: abort.signal });
        if (abort.signal.aborted) { cleanup(); return; }
        // Expose ownership before awaiting a final refresh. Settings changed
        // during model preparation must be able to supersede that refresh.
        own.current = pipeline;
        await pipeline.update(microphoneSettings(useVoiceStore.getState()));
        if (abort.signal.aborted) { cleanup(); return; }
        unregister = registerMicrophonePipeline(pipeline, "test");
        selected = pipeline;
      }
      if (abort.signal.aborted) return;
      audio = new Audio();
      playback.current = audio;
      audio.srcObject = new MediaStream([selected.processedTrack]);
      const device = useVoiceStore.getState().outputDevice;
      await routePlayback(audio, device);
      // A device change during preparation owns the last switch. Do not start
      // playback until that newer queued routing operation has also settled.
      let pending: Promise<void> | undefined;
      do {
        pending = outputRouting.current?.queue;
        await pending;
      } while (playback.current === audio && pending !== outputRouting.current?.queue);
      if (abort.signal.aborted) { cleanup(); return; }
      await audio.play();
      if (abort.signal.aborted) { cleanup(); return; }
      setError(undefined);
      const meter = (db: number) => setMicLevel(Math.max(0, Math.min(100, (db + 60) / 60 * 100)));
      meter(selected.getStatus().outputDb);
      unsubscribe = selected.subscribe((status) => meter(status.outputDb));
    })().catch((failure: unknown) => {
      if (!abort.signal.aborted) {
        setError(failure instanceof Error ? failure.message : String(failure));
        setIsTesting(false);
      }
      cleanup();
    });
    return cleanup;
  }, [isTesting, shared, inputDevice, micProfile, routePlayback]);

  useEffect(() => {
    const pipeline = own.current;
    if (pipeline) void pipeline.update(settings).catch((failure: unknown) => {
      if (own.current === pipeline) setError(failure instanceof Error ? failure.message : String(failure));
    });
  }, [settings]);
  useEffect(() => {
    const audio = playback.current;
    if (!audio) return;
    const operation = routePlayback(audio, outputDevice);
    const revision = outputRouting.current?.revision;
    void operation.catch((failure: unknown) => {
      if (playback.current === audio && outputRouting.current?.revision === revision) {
        setError(failure instanceof Error ? failure.message : String(failure));
      }
    });
  }, [outputDevice, routePlayback]);
  const toggleTesting = useCallback(() => { setMicLevel(0); setError(undefined); setIsTesting((value) => !value); }, []);
  return { isTesting, toggleTesting, micLevel, error };
}
