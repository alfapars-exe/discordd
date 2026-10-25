import { awaitAudioStep, closeAudioContext } from "./audioOperation";

export type P2PPlayback = { ready: Promise<{ fallback: boolean }>; stop(): void; setVolume(volume: number): void };
const gainValue = (value: number) => Number.isFinite(value) ? Math.max(0, Math.min(2, value)) : 0;

/** One remote-only playback graph. Never connects to context.destination: the
 * routed media element is the sole audible owner. Remote tracks are borrowed. */
export function playP2PAudio(stream: MediaStream, options: {
  outputDevice: string; volume: number; isCurrent: () => boolean;
  onFailure: (error: unknown) => void;
}): P2PPlayback {
  const audio = new Audio();
  audio.autoplay = false; audio.volume = 0; audio.muted = true;
  const abort = new AbortController();
  let stopped = false, volume = gainValue(options.volume);
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
    track.removeEventListener("ended", source.ended); source.node.disconnect(); sources.delete(track);
  };
  const stop = () => {
    if (stopped) return;
    stopped = true; abort.abort();
    audio.muted = true; audio.volume = 0; audio.pause(); audio.srcObject = null;
    stream.removeEventListener("addtrack", refresh); stream.removeEventListener("removetrack", refresh);
    for (const track of sources.keys()) remove(track);
    gain?.disconnect();
    destination?.stream.getTracks().forEach(track => track.stop());
    void closeAudioContext(context);
  };
  const failed = (error: unknown) => { if (current()) options.onFailure(error); stop(); };
  function refresh() {
    if (!current() || !context || !gain) return;
    try {
      const tracks = stream.getAudioTracks().filter(track => track.readyState !== "ended");
      for (const track of sources.keys()) if (!tracks.includes(track)) remove(track);
      for (const track of tracks) {
        if (sources.has(track)) continue;
        const node = context.createMediaStreamSource(new MediaStream([track]));
        node.connect(gain);
        const ended = () => remove(track);
        sources.set(track, { node, ended }); track.addEventListener("ended", ended);
      }
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
    let fallback = false;
    if (device && typeof audio.setSinkId !== "function") throw new DOMException("Custom output unavailable", "NotSupportedError");
    if (typeof audio.setSinkId === "function") {
      try { await awaitAudioStep(audio.setSinkId(device), "P2P audio output", abort.signal); }
      catch (error) {
        if (!current()) throw new DOMException("Obsolete P2P playback", "AbortError");
        if (!device || (error as { name?: string })?.name !== "NotFoundError") throw error;
        await awaitAudioStep(audio.setSinkId(""), "P2P default output", abort.signal); fallback = true;
      }
    }
    if (!current()) throw new DOMException("Obsolete P2P playback", "AbortError");
    await awaitAudioStep(context.resume(), "P2P audio context", abort.signal);
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
