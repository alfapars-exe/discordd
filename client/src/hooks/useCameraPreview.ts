import {getAuthSessionSnapshot,subscribeAuthGenerationChanges,subscribeAuthOwnerChanges}from "../api/authSessionEvents";
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
  const auth=useRef(JSON.stringify(getAuthSessionSnapshot()));
  const sameAuth=useCallback(()=>JSON.stringify(getAuthSessionSnapshot())===auth.current,[]);
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
      if (!mounted.current || !sameAuth() || request !== deviceGeneration.current) return;
      setDevices(available.filter((device) => device.kind === "videoinput"));
      setDeviceError(null);
    } catch {
      if (mounted.current && sameAuth() && request === deviceGeneration.current) setDeviceError("cameraDevicesUnavailable");
    }
  }, [sameAuth]);

  useEffect(() => {
    mounted.current = true;
    const retire=()=>{if(sameAuth())return;invalidateRequests();releaseStream();setStream(null);setDevices([]);setError(null);setStatus("idle");};
    const owner=subscribeAuthOwnerChanges(retire),session=subscribeAuthGenerationChanges(retire);
    queueMicrotask(() => { if (mounted.current) void refreshDevices(); });
    const media = navigator.mediaDevices;
    media?.addEventListener?.("devicechange", refreshDevices);
    return () => {
      mounted.current = false;owner();session();
      invalidateRequests();
      media?.removeEventListener?.("devicechange", refreshDevices);
      releaseStream();
    };
  }, [refreshDevices, releaseStream, invalidateRequests,sameAuth]);

  const stopPreview = useCallback(() => {
    ++generation.current;
    releaseStream();
    setStream(null);
    setStatus("idle");
    setError(null);
  }, [releaseStream]);

  const startPreview = useCallback(async () => {
    if(!mounted.current||!sameAuth())return;
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
      if (!mounted.current || !sameAuth() || request !== generation.current) {
        captured.getTracks().forEach((track) => track.stop());
        return;
      }
      if(!captured.getVideoTracks().length||captured.getVideoTracks().some(track=>track.readyState==="ended")){
        captured.getTracks().forEach(track=>track.stop());setError("cameraDisconnected");setStatus("error");return;
      }
      ownedStream.current = captured;
      for (const track of captured.getVideoTracks()) {
        track.addEventListener("ended", () => {
          if (!mounted.current || !sameAuth() || request !== generation.current) return;
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
      if (!mounted.current || !sameAuth() || request !== generation.current) return;
      releaseStream();
      setError(cameraErrorKey(failure));
      setStatus("error");
    }
  }, [refreshDevices, releaseStream,sameAuth]);

  return { devices, deviceError, status, error, stream, startPreview, stopPreview, refreshDevices };
}
