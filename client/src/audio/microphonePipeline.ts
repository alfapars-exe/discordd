import { postGateConfigToWorklet } from "./gateConfig";
import { captureConstraints, desiredEngine, type MicrophoneSettings } from "./microphoneSettings";
import type { MicrophoneStatus } from "./pipelineStatus";
import type { EngineHandle } from "./engines/workletEngine";
// Worklet modules must remain same-origin files: production CSP rejects data:
// scripts, and Vite otherwise inlines this small module into a data URL.
import gateUrl from "./vadGateWorklet.js?url&no-inline";
import { awaitAudioStep, closeAudioContext } from "./audioOperation";

export interface MicrophonePipeline {
  readonly processedTrack: MediaStreamTrack;
  update(settings: MicrophoneSettings): Promise<void>;
  getStatus(): MicrophoneStatus;
  subscribe(listener: (status: MicrophoneStatus) => void): () => void;
  dispose(): Promise<void>;
}
export type PipelineOptions = {
  signal?: AbortSignal;
  /** A dedicated microphone context; ownership transfers to the pipeline. */
  audioContext?: AudioContext;
  applyCapture?: (constraints: MediaTrackConstraints) => Promise<void>;
};
const abortError = () => new DOMException("Microphone operation cancelled", "AbortError");
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** One graph for calls and tests. Source ownership remains with the caller. */
export async function createMicrophonePipeline(
  sourceTrack: MediaStreamTrack,
  initialSettings: MicrophoneSettings,
  options: PipelineOptions = {},
): Promise<MicrophonePipeline> {
  if (options.signal?.aborted) throw abortError();
  const applyCapture = options.applyCapture ?? ((constraints) => sourceTrack.applyConstraints(constraints));
  // Unsupported constraints may resolve successfully while being ignored.
  // Only the capture track's reported setting confirms browser suppression.
  const browserSuppressionEnabled = () => sourceTrack.getSettings?.().noiseSuppression === true;
  const browserSuppressionFailure = "Browser noise suppression could not be verified as enabled";
  const doubleSuppressionFailure = "Browser noise suppression remained enabled; software noise reduction was not started to avoid double processing";
  let settings = { ...initialSettings };
  let status: MicrophoneStatus = {
    requestedEngine: desiredEngine(settings), activeEngine: null, phase: "loading",
    sampleRate: 48000, gateAvailable: true, gateEnabled: settings.micProfile !== "muzik" && settings.micSensitivity < 100, gainAvailable: true,
    inputDb: -120, outputDb: -120, gateOpen: false,
  };
  const listeners = new Set<(status: MicrophoneStatus) => void>();
  const report = (patch: Partial<MicrophoneStatus>) => {
    status = { ...status, ...patch };
    listeners.forEach((fn) => fn(status));
  };
  let context: AudioContext | null = null;
  try {
    context = options.audioContext ?? new AudioContext({ sampleRate: 48000, latencyHint: "interactive" });
    if (context.sampleRate !== 48000 || !context.audioWorklet) throw new Error("48 kHz AudioWorklet unavailable");
    await awaitAudioStep(context.resume(), "Microphone audio context", options.signal);
    await awaitAudioStep(context.audioWorklet.addModule(gateUrl), "Microphone gate module", options.signal);
  } catch (error) {
    // Context ownership was transferred to this pipeline. The clone fallback
    // does not use the failed context, including one supplied by the SDK adapter.
    await closeAudioContext(context);
    if (options.signal?.aborted) throw abortError();
    // Capability fallback is explicit. No unavailable gate or software gain is advertised.
    const output = sourceTrack.clone();
    let disposed = false;
    let serial = Promise.resolve();
    const dispose = async () => {
      if (disposed) return;
      disposed = true;
      options.signal?.removeEventListener("abort", onAbort);
      output.stop();
      listeners.clear();
      await serial.catch(() => {});
    };
    const onAbort = () => { void dispose(); };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const update = (next: MicrophoneSettings) => {
      if (disposed) return Promise.reject(abortError());
      settings = { ...next };
      serial = serial.catch(() => {}).then(async () => {
        if (disposed) throw abortError();
        const requested = desiredEngine(settings);
        const candidate = requested === "none" ? "none" : "webrtc";
        await applyCapture(captureConstraints(settings, candidate));
        if (disposed || options.signal?.aborted) throw abortError();
        await output.applyConstraints(captureConstraints(settings, candidate));
        if (disposed || options.signal?.aborted) throw abortError();
        const active = candidate === "webrtc" && !browserSuppressionEnabled() ? "none" : candidate;
        report({ requestedEngine: requested, activeEngine: active, phase: "fallback",
          sampleRate: output.getSettings().sampleRate ?? 0, gateAvailable: false, gateEnabled: false, gainAvailable: false,
          error: active !== candidate ? browserSuppressionFailure : message(error) });
      });
      return serial;
    };
    try { await update(settings); } catch (failure) { await dispose(); throw failure; }
    return {
      processedTrack: output, update, getStatus: () => status,
      subscribe: (fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
      dispose,
    };
  }
  const ctx = context;
  if (options.signal?.aborted) { await closeAudioContext(ctx); throw abortError(); }
  const channelCount = settings.micProfile === "muzik" ? 2 : 1;
  let source: MediaStreamAudioSourceNode;
  let gate: AudioWorkletNode;
  let gain: GainNode;
  let destination: MediaStreamAudioDestinationNode;
  let analyser: AnalyserNode;
  try {
    source = ctx.createMediaStreamSource(new MediaStream([sourceTrack]));
    gate = new AudioWorkletNode(ctx, "vad-gate-processor", { outputChannelCount: [channelCount] });
    gain = ctx.createGain();
    destination = ctx.createMediaStreamDestination();
    destination.channelCount = channelCount;
    analyser = ctx.createAnalyser();
  } catch (error) {
    await closeAudioContext(ctx);
    throw error;
  }
  analyser.fftSize = 1024;
  gate.connect(gain);
  gain.connect(destination);
  gain.connect(analyser);
  const output = destination.stream.getAudioTracks()[0];
  let engine: EngineHandle | null = null;
  let currentKey = "";
  let disposed = false;
  let generation = 0;
  let controller = new AbortController();
  let serial: Promise<void> = Promise.resolve();
  const failed = new Set<string>();
  let gateHealthy = true;
  let lastGateMessage: number | undefined;
  const gateFailure = "Microphone energy gate stopped; noise reduction continues without the gate";
  const bypassFailedGate = () => {
    if (disposed || !gateHealthy) return;
    gateHealthy = false;
    gate.disconnect();
    if (engine) { engine.output.disconnect(); engine.output.connect(gain); }
    else if (currentKey) { source.disconnect(); source.connect(gain); }
    report({ gateAvailable: false, gateEnabled: false, phase: "fallback", error: gateFailure, errorCode: undefined });
  };
  gate.onprocessorerror = bypassFailedGate;
  const samples = new Float32Array(analyser.fftSize);
  let lastMeterCheckWall = performance.now();
  const timer = setInterval(() => {
    if (disposed) return;
    const now = performance.now();
    const hostWasDelayed = now - lastMeterCheckWall > 2000;
    lastMeterCheckWall = now;
    // A background/throttled main thread may receive this timer before queued
    // meter messages. Give those messages time to catch up before judging DSP.
    if (hostWasDelayed) lastGateMessage = ctx.currentTime;
    else if (gateHealthy && currentKey && lastGateMessage !== undefined && ctx.state === "running" && ctx.currentTime - lastGateMessage > 6) bypassFailedGate();
    analyser.getFloatTimeDomainData(samples);
    let power = 0;
    for (const value of samples) power += value * value;
    report({ outputDb: 10 * Math.log10(Math.max(1e-12, power / samples.length)) });
  }, 100);
  gate.port.onmessage = ({ data }) => {
    if (data?.type === "METER" && !disposed && gateHealthy) {
      lastGateMessage = ctx.currentTime;
      report({ inputDb: data.inputDb, gateOpen: data.gateOpen });
    }
  };
  const controls = () => {
    gain.gain.setTargetAtTime(Math.max(0, Math.min(200, settings.inputVolume)) / 100, ctx.currentTime, 0.005);
    if (gateHealthy) postGateConfigToWorklet(gate, settings.noiseSuppressionLevel, settings.micProfile === "muzik" ? 100 : settings.micSensitivity);
    engine?.setSuppressionLevel?.(settings.deepfilterSuppression);
    const gateEnabled = gateHealthy && settings.micProfile !== "muzik" && settings.micSensitivity < 100;
    if (status.gateEnabled !== gateEnabled) report({ gateEnabled });
  };
  async function reconcile(id: number) {
    if (disposed || id !== generation) return;
    const signal = controller.signal;
    const requested = desiredEngine(settings);
    const key = `${settings.micProfile}:${requested}`;
    controls();
    if (key === currentKey) {
      // A stale candidate may have completed an uncancellable browser capture
      // update. Restore the current engine's policy before declaring readiness.
      await applyCapture(captureConstraints(settings, status.activeEngine ?? "none"));
      if (disposed || id !== generation) return;
      if (engine && sourceTrack.getSettings?.().noiseSuppression === true) {
        // Capture can change underneath a running model. Once browser DSP is
        // confirmed locked on, keep the common gate/gain but remove the second
        // suppressor immediately. The generation guard above protects reverts.
        const old = engine;
        source.disconnect();
        old.output.disconnect();
        source.connect(gateHealthy ? gate : gain);
        engine = null;
        report({ requestedEngine: requested, activeEngine: "webrtc", phase: "fallback",
          error: doubleSuppressionFailure, errorCode: "browser-noise-suppression-locked" });
        await old.dispose().catch(() => {});
        return;
      }
      const active = status.activeEngine === "webrtc" && !browserSuppressionEnabled() ? "none" : status.activeEngine;
      // A newer request may return to the still-running engine while a
      // different candidate is being cancelled. Restore its visible state.
      report({ requestedEngine: requested, activeEngine: active, phase: gateHealthy && active === requested ? "ready" : "fallback",
        errorCode: active !== status.activeEngine || active === requested || !gateHealthy ? undefined : status.errorCode,
        error: active !== status.activeEngine ? browserSuppressionFailure : !gateHealthy ? gateFailure : active === requested ? undefined : status.error });
      return;
    }
    report({ requestedEngine: requested, phase: "loading", error: undefined, errorCode: undefined });
    const candidates = requested === "none" || requested === "webrtc"
      ? [requested] : [...new Set([requested, "rnnoise", "webrtc"])];
    let lastError: unknown;
    let lastErrorCode: MicrophoneStatus["errorCode"];
    for (const candidate of candidates) {
      if (failed.has(candidate)) continue;
      let next: EngineHandle | null = null;
      try {
        const onError = (error: Error) => {
          if (disposed || engine !== next || !next) return;
          failed.add(candidate);
          currentKey = "";
          report({ error: error.message, errorCode: undefined });
          void update(settings, false).catch(() => {});
        };
        if (candidate === "dtln") {
          const { createDtlnEngine } = await import("./engines/dtlnEngine");
          next = await createDtlnEngine(ctx, { signal, onError });
        } else if (["rnnoise", "gtcrn", "speex", "deepfilter"].includes(candidate)) {
          const { createWorkletEngine } = await import("./engines/workletEngine");
          next = await createWorkletEngine(ctx, candidate as "rnnoise" | "gtcrn" | "speex" | "deepfilter", {
            suppression: settings.deepfilterSuppression, signal, onError,
          });
        }
        if (disposed || id !== generation) { await next?.dispose(); return; }
        // Update source constraints, including LiveKit's stored constraints, before committing.
        await applyCapture(captureConstraints(settings, candidate));
        if (disposed || id !== generation) { await next?.dispose(); return; }
        if (next && sourceTrack.getSettings?.().noiseSuppression === true) throw new Error(doubleSuppressionFailure);
        const active = candidate === "webrtc" && !browserSuppressionEnabled() ? "none" : candidate;
        const old = engine;
        source.disconnect();
        old?.output.disconnect();
        const sink = gateHealthy ? gate : gain;
        if (next) { source.connect(next.input); next.output.connect(sink); }
        else source.connect(sink);
        engine = next;
        currentKey = key;
        lastGateMessage ??= ctx.currentTime;
        controls();
        report({ activeEngine: active, phase: gateHealthy && active === requested ? "ready" : "fallback",
          errorCode: active !== candidate || !gateHealthy ? undefined : lastErrorCode,
          error: active !== candidate ? browserSuppressionFailure : !gateHealthy ? gateFailure : lastError ? message(lastError) : undefined });
        await old?.dispose().catch(() => {});
        return;
      } catch (error) {
        await next?.dispose().catch(() => {});
        if (disposed || id !== generation) return;
        lastError = error;
        lastErrorCode = message(error) === doubleSuppressionFailure ? "browser-noise-suppression-locked" : undefined;
      }
    }
    report({ phase: "error", error: message(lastError ?? "No microphone engine available"), errorCode: lastErrorCode });
    if (!currentKey) throw lastError ?? new Error("No microphone engine available");
  }
  function update(next: MicrophoneSettings, resetFailures = true) {
    const previous = desiredEngine(settings);
    settings = { ...next };
    if (disposed) return Promise.reject(abortError());
    if (resetFailures && previous !== desiredEngine(settings)) failed.clear();
    controls();
    controller.abort();
    controller = new AbortController();
    const id = ++generation;
    serial = serial.catch(() => {}).then(() => reconcile(id));
    return serial;
  }
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    ++generation;
    controller.abort();
    clearInterval(timer);
    source.disconnect();
    gate.onprocessorerror = null;
    gate.port.postMessage({ type: "DESTROY" });
    gate.port.close();
    gate.disconnect();
    gain.disconnect();
    analyser.disconnect();
    destination.disconnect();
    output.stop();
    listeners.clear();
    await serial.catch(() => {});
    await engine?.dispose().catch(() => {});
    engine = null;
    await closeAudioContext(ctx);
  };
  const onAbort = () => { void dispose(); };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    await update(settings);
    if (disposed || options.signal?.aborted) throw abortError();
  } catch (error) { await dispose(); throw error; }
  return {
    processedTrack: output, update, getStatus: () => status,
    subscribe: (fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    dispose: async () => { options.signal?.removeEventListener("abort", onAbort); await dispose(); },
  };
}
