import { useCallback, useEffect, useRef, useState } from "react";
import { useVoiceStore } from "../stores/voiceStore";
import { cameraConstraintsFor, cameraErrorKey } from "../utils/cameraCapture";

type PreviewStatus = "idle" | "starting" | "active" | "error";

/** Local, video-only preview. Listing settings never requests capture access. */
export function useCameraPreview() {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const [status, setStatus] = useState<PreviewStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const ownedStream = useRef<MediaStream | null>(null);
  const generation = useRef(0);
  const deviceGeneration = useRef(0);
  const mounted = useRef(false);

  const releaseStream = useCallback(() => {
    const owned = ownedStream.current;
    ownedStream.current = null;
    owned?.getTracks().forEach((track) => track.stop());
  }, []);

  const invalidateRequests = useCallback(() => {
    ++generation.current;
    ++deviceGeneration.current;
  }, []);

  const refreshDevices = useCallback(async () => {
    const request = ++deviceGeneration.current;
    try {
      if (!navigator.mediaDevices?.enumerateDevices) throw new Error("unsupported");
      const available = await navigator.mediaDevices.enumerateDevices();
      if (!mounted.current || request !== deviceGeneration.current) return;
      setDevices(available.filter((device) => device.kind === "videoinput"));
      setDeviceError(null);
    } catch {
      if (mounted.current && request === deviceGeneration.current) setDeviceError("cameraDevicesUnavailable");
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    queueMicrotask(() => { if (mounted.current) void refreshDevices(); });
    const media = navigator.mediaDevices;
    media?.addEventListener?.("devicechange", refreshDevices);
    return () => {
      mounted.current = false;
      invalidateRequests();
      media?.removeEventListener?.("devicechange", refreshDevices);
      releaseStream();
    };
  }, [refreshDevices, releaseStream, invalidateRequests]);

  const stopPreview = useCallback(() => {
    ++generation.current;
    releaseStream();
    setStream(null);
    setStatus("idle");
    setError(null);
  }, [releaseStream]);

  const startPreview = useCallback(async () => {
    const request = ++generation.current;
    releaseStream();
    setStream(null);
    setError(null);
    setStatus("starting");
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError("cameraUnsupported");
        setStatus("error");
        return;
      }
      const { cameraQuality, cameraFps, cameraDevice } = useVoiceStore.getState();
      const captured = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: cameraConstraintsFor(cameraQuality, cameraFps, cameraDevice),
      });
      if (!mounted.current || request !== generation.current) {
        captured.getTracks().forEach((track) => track.stop());
        return;
      }
      ownedStream.current = captured;
      for (const track of captured.getVideoTracks()) {
        track.addEventListener("ended", () => {
          if (!mounted.current || request !== generation.current) return;
          ++generation.current;
          releaseStream();
          setStream(null);
          setError("cameraDisconnected");
          setStatus("error");
        }, { once: true });
      }
      setStream(captured);
      setStatus("active");
      void refreshDevices(); // Permission can reveal previously hidden labels.
    } catch (failure) {
      if (!mounted.current || request !== generation.current) return;
      releaseStream();
      setError(cameraErrorKey(failure));
      setStatus("error");
    }
  }, [refreshDevices, releaseStream]);

  return { devices, deviceError, status, error, stream, startPreview, stopPreview, refreshDevices };
}
