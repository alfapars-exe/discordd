/** Original procedural instrumental; no remote tracks, recordings or runtime dependencies. */
const SAMPLE_RATE = 22_050;
const BEAT = 60 / 72;
const LOOP_SECONDS = BEAT * 32;
const OUTPUT_GAIN = 0.35;

export type LofiOutputResult = { fallback: boolean; supported: boolean };
export type LofiPlayer = {
  play(): Promise<LofiOutputResult | void>;
  pause(): Promise<void>;
  stop(): Promise<void>;
  setVolume(volume: number): void;
  setOutputDevice(deviceId: string): Promise<LofiOutputResult>;
  dispose(): Promise<void>;
};
type SinkContext = AudioContext & { readonly sinkId?: string | object; setSinkId?: (id: string) => Promise<void> };
const normalizedDevice = (id: string) => id || "default";
const supportsSink = () => typeof AudioContext !== "undefined" && typeof (AudioContext.prototype as SinkContext).setSinkId === "function";
const clampVolume = (volume: number) => Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 0;

/** Eight bars, bounded to ~2.4 MB, generated only on the first explicit play. */
function renderLoop(context: AudioContext): AudioBuffer {
  const length = Math.round(LOOP_SECONDS * SAMPLE_RATE);
  const buffer = context.createBuffer(1, length, SAMPLE_RATE);
  const samples = buffer.getChannelData(0);
  let seed = 0x4c6f4669;
  const noise = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x80000000 - 1; };
  const frequency = (midi: number) => 440 * 2 ** ((midi - 69) / 12);
  const add = (start: number, duration: number, voice: (time: number) => number) => {
    const first = Math.round(start * SAMPLE_RATE);
    const count = Math.ceil(duration * SAMPLE_RATE);
    for (let index = 0; index < count; index++) samples[(first + index) % length] += voice(index / SAMPLE_RATE);
  };
  const note = (midi: number, start: number, duration: number, volume: number, bass = false) => {
    const hz = frequency(midi);
    add(start, duration, (time) => {
      const envelope = Math.min(1, time / 0.012) * Math.exp(-time * (bass ? 4 : 2.5)) * Math.min(1, (duration - time) / 0.08);
      const phase = 2 * Math.PI * hz * time;
      return volume * envelope * (Math.sin(phase) + (bass ? 0.12 : 0.22) * Math.sin(phase * 2) + (bass ? 0 : 0.06) * Math.sin(phase * 3));
    });
  };
  const chords = [[53, 57, 60, 64], [50, 53, 57, 60], [55, 59, 62, 65], [48, 52, 55, 59]];
  for (let bar = 0; bar < 8; bar++) {
    const start = bar * 4 * BEAT;
    const chord = chords[bar % chords.length];
    for (const beat of [0, 1.5, 2.75]) {
      for (const [index, midi] of chord.entries()) note(midi + (bar >= 4 && index === 3 ? 12 : 0), start + beat * BEAT + index * 0.009, 1.65, beat === 0 ? 0.065 : 0.044);
    }
    note(chord[0] - 12, start, BEAT * 1.6, 0.16, true);
    note(chord[0] - 12, start + BEAT * 2.5, BEAT * 1.3, 0.12, true);
    for (const beat of [0, 2.5]) add(start + beat * BEAT, 0.32, (time) => 0.25 * Math.exp(-time * 18) * Math.sin(2 * Math.PI * (48 * time + 2.2 * (1 - Math.exp(-time * 30)))));
    for (const beat of [1, 3]) add(start + beat * BEAT + 0.018, 0.19, (time) => 0.065 * Math.exp(-time * 24) * (noise() + 0.25 * Math.sin(2 * Math.PI * 180 * time)));
    for (let eighth = 0; eighth < 8; eighth++) add(start + (eighth / 2 + (eighth % 2 ? 0.055 : 0)) * BEAT, 0.065, (time) => (eighth % 2 ? 0.019 : 0.027) * Math.exp(-time * 85) * noise());
  }
  let filteredNoise = 0;
  let peak = 0;
  for (let index = 0; index < length; index++) {
    filteredNoise = filteredNoise * 0.82 + noise() * 0.18;
    samples[index] += filteredNoise * 0.002;
    // A short seam fade avoids clicks without retaining extra tail buffers.
    samples[index] *= Math.min(1, index / 220, (length - 1 - index) / 220);
    peak = Math.max(peak, Math.abs(samples[index]));
  }
  if (peak > 0) for (let index = 0; index < length; index++) samples[index] *= 0.8 / peak;
  return buffer;
}

export function createLofiPlayer(): LofiPlayer {
  let context: SinkContext | null = null;
  let gain: GainNode | null = null;
  let buffer: AudioBuffer | null = null;
  let source: AudioBufferSourceNode | null = null;
  let volume = 0.35;
  let deviceId = "default";
  let outputRevision = 0;
  let offset = 0;
  let startedAt = 0;
  let generation = 0;
  let disposed = false;
  let pendingPlay: Promise<LofiOutputResult | void> | null = null;
  let pendingDispose: Promise<void> | null = null;
  let sinkQueue: Promise<void> = Promise.resolve();

  const route = (ctx: SinkContext, target: string): Promise<LofiOutputResult> => {
    const operation = sinkQueue.then(async () => {
      if (disposed || context !== ctx) return { fallback: false, supported: true };
      if (typeof ctx.setSinkId !== "function") return { fallback: false, supported: target === "default" };
      // Web Audio represents the system default with an empty string. A fresh
      // context already uses it; avoid needless output selection/permission work.
      const sinkId = target === "default" ? "" : target;
      if (ctx.sinkId === sinkId) return { fallback: false, supported: true };
      try {
        await ctx.setSinkId(sinkId);
        return { fallback: false, supported: true };
      } catch (error) {
        if (disposed || context !== ctx) return { fallback: false, supported: true };
        if (target === "default" || typeof error !== "object" || error === null || !("name" in error) || error.name !== "NotFoundError") throw error;
        await ctx.setSinkId("");
        return { fallback: true, supported: true };
      }
    });
    sinkQueue = operation.then(() => undefined, () => undefined);
    return operation;
  };
  const stopSource = (preserveOffset: boolean) => {
    generation++;
    pendingPlay = null;
    const active = source;
    source = null;
    if (active) {
      if (preserveOffset && context && buffer) offset = (offset + Math.max(0, context.currentTime - startedAt)) % buffer.duration;
      active.onended = null;
      try { active.stop(); } finally { active.disconnect(); }
    }
    if (!preserveOffset) offset = 0;
  };

  return {
    play() {
      if (disposed) return Promise.reject(new Error("lofi_disposed"));
      if (source) return Promise.resolve();
      if (pendingPlay) return pendingPlay;
      const token = ++generation;
      const current = () => !disposed && generation === token;
      const operation = (async () => {
        if (!context) {
          context = new AudioContext();
          gain = context.createGain();
          gain.gain.setValueAtTime(volume * OUTPUT_GAIN, context.currentTime);
          gain.connect(context.destination);
        }
        const ctx = context;
        await ctx.resume();
        if (!current()) return;
        const revision = outputRevision;
        const routed = await route(ctx, deviceId);
        if (!current()) return;
        if (!routed.supported) throw new Error("lofi_output_unsupported");
        if (revision !== outputRevision) throw new Error("lofi_output_changed");
        buffer ??= renderLoop(ctx);
        if (!current()) return;
        const next = ctx.createBufferSource();
        next.buffer = buffer;
        next.loop = true;
        next.connect(gain!);
        try { next.start(0, offset); } catch (error) { next.disconnect(); throw error; }
        startedAt = ctx.currentTime;
        source = next;
        return routed;
      })();
      pendingPlay = operation;
      const clear = () => { if (pendingPlay === operation) pendingPlay = null; };
      void operation.then(clear, clear);
      return operation;
    },
    pause() { stopSource(true); return Promise.resolve(); },
    stop() { stopSource(false); return Promise.resolve(); },
    setVolume(nextVolume) {
      volume = clampVolume(nextVolume);
      if (context && gain && !disposed) gain.gain.setValueAtTime(volume * OUTPUT_GAIN, context.currentTime);
    },
    setOutputDevice(nextDeviceId) {
      const next = normalizedDevice(nextDeviceId);
      if (next !== deviceId) outputRevision++;
      deviceId = next;
      if (disposed) return Promise.reject(new Error("lofi_disposed"));
      if (!context) return Promise.resolve({ fallback: false, supported: deviceId === "default" || supportsSink() });
      return route(context, deviceId).then((result) => {
        if (!result.supported) stopSource(true);
        return result;
      }, (error: unknown) => {
        stopSource(true);
        throw error;
      });
    },
    dispose() {
      if (pendingDispose) return pendingDispose;
      disposed = true;
      stopSource(false);
      gain?.disconnect();
      gain = null;
      buffer = null;
      const closing = context;
      context = null;
      pendingDispose = closing && closing.state !== "closed" ? closing.close() : Promise.resolve();
      return pendingDispose;
    },
  };
}
