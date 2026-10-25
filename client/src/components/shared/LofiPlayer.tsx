import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { createLofiPlayer } from "../../audio/lofiEngine";
import { getAuthSessionSnapshot, subscribeAuthGenerationChanges, subscribeAuthOwnerChanges } from "../../api/authSessionEvents";
import { useVoiceStore } from "../../stores/voiceStore";
import "./LofiPlayer.css";

function playbackErrorKey(error: unknown): string {
  if (!error || typeof error !== "object") return "lofiPlaybackError";
  const name = "name" in error ? error.name : undefined;
  if (name === "NotAllowedError" || name === "SecurityError") return "lofiPermissionError";
  if (name === "NotFoundError" || name === "NotReadableError") return "lofiDeviceError";
  if ("message" in error && error.message === "lofi_output_unsupported") return "lofiOutputUnsupported";
  return "lofiPlaybackError";
}

export default function LofiPlayer({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation("common");
  const dialog = useRef<HTMLDialogElement>(null);
  const controller = useRef<ReturnType<typeof createLofiPlayer> | null>(null);
  const alive = useRef(false);
  const epoch = useRef(0);
  const outputQueue = useRef<Promise<void>>(Promise.resolve());
  const outputRevision = useRef(0);
  const closeCallback = useRef(onClose);
  useEffect(() => { closeCallback.current = onClose; }, [onClose]);
  const [volume, setVolume] = useState(20);
  const [status, setStatus] = useState("lofiStopped");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [outputNotice, setOutputNotice] = useState("");
  const outputDevice = useVoiceStore((s) => s.outputDevice);
  const masterVolume = useVoiceStore((s) => s.masterVolume);
  const deafened = useVoiceStore((s) => s.isDeafened);
  const serverDeafened = useVoiceStore((s) => s.isServerDeafened);
  const muted = deafened || serverDeafened;

  function retire() {
    alive.current = false;
    epoch.current++;
    const player = controller.current;
    controller.current = null;
    void player?.dispose().catch(() => {});
  }
  function close() { retire(); closeCallback.current(); }

  useEffect(() => {
    const previousFocus = document.activeElement;
    const element = dialog.current;
    const scope = getAuthSessionSnapshot();
    alive.current = true;
    controller.current = createLofiPlayer();
    const changed = () => {
      const current = getAuthSessionSnapshot();
      if (alive.current && (current.ownerId !== scope.ownerId || current.generation !== scope.generation)) {
        retire();
        closeCallback.current();
      }
    };
    const unsubscribeOwner = subscribeAuthOwnerChanges(changed);
    const unsubscribeGeneration = subscribeAuthGenerationChanges(changed);
    element?.showModal();
    return () => {
      unsubscribeOwner(); unsubscribeGeneration(); retire(); element?.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, []);

  useEffect(() => {
    const player = controller.current;
    const revision = ++outputRevision.current;
    outputQueue.current = outputQueue.current.catch(() => {}).then(async () => {
      if (!alive.current || controller.current !== player || !player) return;
      try {
        const result = await player.setOutputDevice(outputDevice);
        if (alive.current && controller.current === player && revision === outputRevision.current) {
          setOutputNotice(result.fallback ? "lofiOutputFallback" : !result.supported && !!outputDevice && outputDevice !== "default" ? "lofiOutputUnsupported" : "");
          if (!result.supported) {
            epoch.current++;
            setBusy(false);
            setStatus((previous) => previous === "lofiPlaying" ? "lofiPaused" : previous);
          }
        }
      } catch {
        if (alive.current && controller.current === player && revision === outputRevision.current) {
          epoch.current++;
          setBusy(false);
          setOutputNotice("lofiOutputError");
          setStatus((previous) => previous === "lofiPlaying" ? "lofiPaused" : previous);
        }
        throw new Error("Output selection failed");
      }
    });
    // Keep rejection handled even when no play action is waiting on this queue.
    void outputQueue.current.catch(() => {});
  }, [outputDevice]);

  useEffect(() => { controller.current?.setVolume(muted ? 0 : volume / 100 * masterVolume / 100); }, [volume, masterVolume, muted]);

  async function act(action: "play" | "pause" | "stop") {
    const player = controller.current;
    if (!player || !alive.current) return;
    const operation = ++epoch.current;
    setBusy(true); setError("");
    try {
      if (action === "play") {
        let pending;
        do {
          pending = outputQueue.current;
          try { await pending; } catch {
            if (!alive.current || controller.current !== player || operation !== epoch.current) return;
            const retry = pending.catch(() => {}).then(() => player.setOutputDevice(outputDevice)).then((result) => {
              if (alive.current && controller.current === player) setOutputNotice(result.fallback ? "lofiOutputFallback" : !result.supported && !!outputDevice && outputDevice !== "default" ? "lofiOutputUnsupported" : "");
            });
            outputQueue.current = retry;
            await retry;
          }
        } while (pending !== outputQueue.current);
      }
      if (!alive.current || controller.current !== player || operation !== epoch.current) return;
      const result = await player[action]();
      if (alive.current && controller.current === player && operation === epoch.current) {
        if (action === "play" && result) setOutputNotice(result.fallback ? "lofiOutputFallback" : !result.supported ? "lofiOutputUnsupported" : "");
        setStatus(action === "play" ? result && !result.supported ? "lofiPaused" : "lofiPlaying" : action === "pause" ? "lofiPaused" : "lofiStopped");
      }
    } catch (failure) {
      if (alive.current && controller.current === player && operation === epoch.current) setError(playbackErrorKey(failure));
    } finally {
      if (alive.current && controller.current === player && operation === epoch.current) setBusy(false);
    }
  }

  return <dialog className="lofi-player" ref={dialog} aria-labelledby="lofi-title" onCancel={(event) => { event.preventDefault(); close(); }}>
    <h2 id="lofi-title">{t("lofiTitle")}</h2>
    <p>{t("lofiLocalSource")}</p>
    <p role="status" aria-live="polite">{t(busy ? "lofiWorking" : status)}</p>
    {error && <p role="alert">{t(error)}</p>}
    {outputNotice && <p role="status">{t(outputNotice)}</p>}
    {muted && <p>{t("lofiDeafened")}</p>}
    <div className="lofi-player-actions">
      <button type="button" disabled={busy} onClick={() => void act("play")}>{t("lofiPlay")}</button>
      <button type="button" onClick={() => void act("pause")}>{t("lofiPause")}</button>
      <button type="button" onClick={() => void act("stop")}>{t("lofiStop")}</button>
    </div>
    <label className="lofi-player-volume">{t("lofiVolume")} {volume}%
      <input type="range" min="0" max="100" value={volume} onChange={(event) => setVolume(Number(event.target.value))} />
    </label>
    <button type="button" onClick={close}>{t("close")}</button>
  </dialog>;
}
