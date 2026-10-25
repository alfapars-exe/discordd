import { awaitAudioStep } from "./audioOperation";

export type SoundboardPlayback = { ready: Promise<{ fallback: boolean }>; stop(): void; setVolume(volume: number): void; isActive(): boolean };
export const soundboardVolume = (value: number) => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;

/** File-audio equivalent of the event-sound routing policy: route before play,
 * default fallback only for a vanished device, and no custom-output pretense. */
export function playSoundboardAudio(url: string, options: {
  outputDevice: string; volume: number; isCurrent: () => boolean;
  startAt?: number; durationMs?: number;
  onStop: () => void; onFailure: (error: unknown) => void;
}): SoundboardPlayback {
  const audio = new Audio(url);
  const controller = new AbortController();
  let stopped = false, volume = soundboardVolume(options.volume);
  let timer: ReturnType<typeof setTimeout> | undefined;
  audio.volume = 0;
  const current = () => !stopped && options.isCurrent();
  const stop = () => {
    if (stopped) return;
    stopped = true; controller.abort(); clearTimeout(timer);
    audio.removeEventListener("ended", stop);
    audio.removeEventListener("error", failed);
    audio.pause(); audio.removeAttribute("src"); audio.load();
    options.onStop();
  };
  const failed = () => { if (current()) options.onFailure(new Error("soundboard_media_failed")); stop(); };
  audio.addEventListener("ended", stop);
  audio.addEventListener("error", failed);
  const ready = (async () => {
    if (!current()) throw new DOMException("Obsolete playback", "AbortError");
    const device = options.outputDevice === "default" ? "" : options.outputDevice;
    let fallback = false;
    if (device && typeof audio.setSinkId !== "function") throw new DOMException("Custom audio output unavailable", "NotSupportedError");
    if (typeof audio.setSinkId === "function") {
      try { await awaitAudioStep(audio.setSinkId(device), "Soundboard output", controller.signal); }
      catch (error) {
        if (!current()) throw new DOMException("Obsolete playback", "AbortError");
        if (!device || (error as { name?: string })?.name !== "NotFoundError") throw error;
        await awaitAudioStep(audio.setSinkId(""), "Soundboard default output", controller.signal); fallback = true;
      }
    }
    if (!current()) throw new DOMException("Obsolete playback", "AbortError");
    if (options.startAt !== undefined) audio.currentTime = Math.max(0, options.startAt);
    audio.volume = volume;
    const playing = audio.play();
    // Some browser audio promises settle after their cancellation. A late
    // successful play may never resurrect an obsolete call or preview.
    void playing.then(() => { if (!current()) audio.pause(); }, () => {});
    await awaitAudioStep(playing, "Soundboard playback", controller.signal);
    if (!current()) throw new DOMException("Obsolete playback", "AbortError");
    if (options.durationMs !== undefined) timer = setTimeout(stop, Math.max(0, options.durationMs));
    return { fallback };
  })().catch((error: unknown) => {
    if (!controller.signal.aborted && options.isCurrent()) options.onFailure(error);
    stop(); throw error;
  });
  return { ready, stop, isActive: current, setVolume(value) { volume = soundboardVolume(value); if (current()) audio.volume = volume; } };
}
