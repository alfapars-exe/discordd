import { awaitAudioStep, closeAudioContext } from "./audioOperation";
import { routeAudioOutput } from "./outputRouting";

export type P2PPlayback = { ready: Promise<{ fallback: boolean }>; stop(): void; setVolume(volume: number): void };
const gainValue = (value: number) => Number.isFinite(value) ? Math.max(0, Math.min(2, value)) : 0;

/** One remote-only playback graph. Never connects to context.destination: the
 * routed media element is the sole audible owner. Remote tracks are borrowed. */
export function playP2PAudio(stream: MediaStream, options: {
  outputDevice: string; volume: number; isCurrent: () => boolean;
  onFailure: (error: unknown) => void;
}): P2PPlayback {
  const audio = new Audio();
  // Chromium needs a playing raw-track element to pull decoded WebRTC audio
  // into WebAudio. This element is never audible; routing stays on audio.
  const decoder = new Audio();
  const decoderStream = new MediaStream();
  decoder.autoplay = false; decoder.volume = 0; decoder.muted = false;
  decoder.srcObject = decoderStream;
  decoder.onvolumechange = () => { if (decoder.volume !== 0) decoder.volume = 0; };
  audio.autoplay = false; audio.volume = 0; audio.muted = true;
  const abort = new AbortController();
  let stopped = false, volume = gainValue(options.volume);
  let routed = false, decoderPlaying = false, decoderVersion = 0;
  let decoderPending: Promise<void> | null = null;
  let decoderAbort: AbortController | null = null;
  let context: AudioContext | undefined, gain: GainNode | undefined, destination: MediaStreamAudioDestinationNode | undefined;
  const sources = new Map<MediaStreamTrack, { node: MediaStreamAudioSourceNode; ended: () => void }>();
  const current = () => !stopped && options.isCurrent();
  const setVolume = (value: number) => {
    volume = gainValue(value);
    if (!current()) return;
    if (gain && context) gain.gain.setValueAtTime(volume, context.currentTime);
    audio.muted = volume === 0;
  };
  const remove = (track: MediaStreamTrack) => {
    const source = sources.get(track); if (!source) return;
    track.removeEventListener("ended", source.ended); source.node.disconnect(); decoderStream.removeTrack(track); sources.delete(track);
  };
  const stop = () => {
    if (stopped) return;
    stopped = true; decoderVersion++; decoderAbort?.abort(); abort.abort();
    audio.muted = true; audio.volume = 0; audio.pause(); audio.srcObject = null;
    decoder.onvolumechange = null; decoder.volume = 0; decoder.muted = true;
    decoder.pause(); decoder.srcObject = null;
    stream.removeEventListener("addtrack", refresh); stream.removeEventListener("removetrack", refresh);
    for (const track of sources.keys()) remove(track);
    gain?.disconnect();
    destination?.stream.getTracks().forEach(track => track.stop());
    void closeAudioContext(context);
  };
  const failed = (error: unknown) => { if (current()) options.onFailure(error); stop(); };
  function ensureDecoder(): Promise<void> {
    if (!current() || !routed || !decoderStream.getAudioTracks().length || decoderPlaying) return Promise.resolve();
    if (decoderPending) return decoderPending;
    const version = decoderVersion;
    const activation = new AbortController(); decoderAbort = activation;
    const playing = decoder.play();
    void playing.then(() => { if (!current()) { decoder.volume = 0; decoder.muted = true; decoder.pause(); decoder.srcObject = null; } }, () => {});
    const pending = awaitAudioStep(playing, "Private decoder activation", activation.signal).then(() => {
      if (!current()) throw new DOMException("Obsolete private decoder", "AbortError");
      if (version === decoderVersion) decoderPlaying = true;
    }).catch((error: unknown) => { if (!current() || version === decoderVersion) throw error; });
    decoderPending = pending;
    void pending.finally(() => { if (decoderPending === pending) decoderPending = null; }).catch(() => {});
    return pending;
  }
  function refresh() {
    if (!current() || !context || !gain) return;
    try {
      const tracks = stream.getAudioTracks().filter(track => track.readyState !== "ended");
      for (const track of sources.keys()) if (!tracks.includes(track)) remove(track);
      for (const track of decoderStream.getTracks()) if (!tracks.includes(track)) decoderStream.removeTrack(track);
      for (const track of tracks) {
        if (sources.has(track)) continue;
        if (!decoderStream.getTracks().includes(track)) decoderStream.addTrack(track);
        const node = context.createMediaStreamSource(new MediaStream([track]));
        node.connect(gain);
        const ended = () => { remove(track); refresh(); };
        sources.set(track, { node, ended }); track.addEventListener("ended", ended);
      }
      if (!tracks.length && (decoderPlaying || decoderPending)) {
        decoderVersion++; decoderAbort?.abort(); decoderAbort = null; decoderPlaying = false; decoderPending = null; decoder.pause();
      } else if (tracks.length && routed) void ensureDecoder().catch((error: unknown) => { if (current()) failed(error); });
    } catch (error) { failed(error); }
  }
  const ready = (async () => {
    if (!current()) throw new DOMException("Obsolete P2P playback", "AbortError");
    context = new AudioContext({ latencyHint: "interactive" });
    gain = context.createGain(); gain.gain.setValueAtTime(0, context.currentTime);
    destination = context.createMediaStreamDestination(); gain.connect(destination);
    audio.srcObject = destination.stream;
    stream.addEventListener("addtrack", refresh); stream.addEventListener("removetrack", refresh); refresh();
    if (!current()) throw new DOMException("Obsolete P2P playback", "AbortError");
    const device = options.outputDevice === "default" ? "" : options.outputDevice;
    const route = async (target: string) => {
      for (const element of [audio, decoder]) {
        if (target && typeof element.setSinkId !== "function") throw new DOMException("Custom output unavailable", "NotSupportedError");
        if (typeof element.setSinkId === "function") await awaitAudioStep(element.setSinkId(target), "Private audio output", abort.signal);
        if (!current()) throw new DOMException("Obsolete private output", "AbortError");
      }
    };
    const fallback = await routeAudioOutput(device, route, { defaultSink: "", isCurrent: current });
    if (!current()) throw new DOMException("Obsolete P2P playback", "AbortError");
    routed = true;
    await ensureDecoder();
    if (!current()) throw new DOMException("Obsolete private decoder", "AbortError");
    await awaitAudioStep(context.resume(), "P2P audio context", abort.signal);
    if (context.state !== "running") throw new DOMException("Private audio context is not running", "NotAllowedError");
    if (!current()) throw new DOMException("Obsolete P2P playback", "AbortError");
    audio.volume = 1; setVolume(volume);
    const playing = audio.play();
    void playing.then(() => { if (!current()) { audio.muted = true; audio.pause(); } }, () => {});
    await awaitAudioStep(playing, "P2P audio playback", abort.signal);
    if (!current()) throw new DOMException("Obsolete P2P playback", "AbortError");
    return { fallback };
  })().catch((error: unknown) => { if (!abort.signal.aborted && options.isCurrent()) options.onFailure(error); stop(); throw error; });
  return { ready, stop, setVolume };
}
