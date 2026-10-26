import { useCallback, useEffect, useRef, useState } from "react";
import { DisconnectReason } from "livekit-client";
import { useVoiceStore } from "../stores/voiceStore";
import { useVoiceRecoveryStore } from "../stores/voiceRecoveryStore";
import { voiceFailureKind, type VoiceFailureKind } from "../audio/voiceFailure";
import { getAuthSessionSnapshot, subscribeAuthGenerationChanges, subscribeAuthOwnerChanges } from "../api/authSessionEvents";
import { logToServer } from "../api/clientLog";

const DELAYS = [1000, 3000, 7000];

/** One recovery owner for terminal SDK disconnects and fail-closed E2EE errors. */
export function useVoiceAutoRejoin(isNativeVoice: boolean) {
  const [restartId, setRestartId] = useState(0);
  const phase = useVoiceRecoveryStore(s => s.phase);
  const control = useRef({ attempts: 0, busy: false, generation: 0,
    timer: undefined as ReturnType<typeof setTimeout> | undefined,
    stable: undefined as ReturnType<typeof setTimeout> | undefined });
  const clear = useCallback(() => {
    const c = control.current;
    c.generation++; c.busy = false;
    clearTimeout(c.timer); clearTimeout(c.stable);
    c.timer = undefined; c.stable = undefined;
  }, []);
  const reset = useCallback(() => {
    clear(); control.current.attempts = 0;
    useVoiceRecoveryStore.setState({ phase: "idle", attempt: 0, retry: null, leave: null });
  }, [clear]);
  const leave = useCallback(() => {
    reset();
    const s = useVoiceStore.getState();
    if (s._onLeaveCallback) s._onLeaveCallback(); else s.leaveVoiceChannel();
  }, [reset]);

  const scheduleRef = useRef<(kind: VoiceFailureKind) => void>(() => {});
  const schedule = useCallback((kind: VoiceFailureKind) => {
    const c = control.current, s = useVoiceStore.getState();
    const terminal = ["unsupported", "access", "session"].includes(kind);
    if (isNativeVoice || !s.currentVoiceChannelId || s.wasReplaced || (c.busy && !terminal)) return;
    const recovery = useVoiceRecoveryStore.getState();
    if (recovery.phase === "failed" && !recovery.retry) return;
    clearTimeout(c.stable); c.stable = undefined;
    // Media flags are cleared even for terminal failures, before Room disposal.
    useVoiceStore.setState({ isCameraEnabled: false, isStreaming: false });
    const retry = terminal ? null : () => {
      clear(); control.current.attempts = 0; scheduleRef.current(kind);
    };
    if (terminal || c.attempts >= DELAYS.length) {
      clear();
      useVoiceRecoveryStore.setState({ phase: "failed", kind, attempt: c.attempts, retry, leave });
      logToServer("warn", "voice_recovery", { stage: kind, attempt: c.attempts, outcome: "failed" });
      return;
    }
    c.busy = true;
    const generation = c.generation;
    const channel = s.currentVoiceChannelId, join = s._joinGeneration;
    const auth = JSON.stringify(getAuthSessionSnapshot());
    const current = () => c.generation === generation
      && useVoiceStore.getState().currentVoiceChannelId === channel
      && useVoiceStore.getState()._joinGeneration === join
      && !useVoiceStore.getState().wasReplaced
      && JSON.stringify(getAuthSessionSnapshot()) === auth;
    useVoiceRecoveryStore.setState({ phase: navigator.onLine ? "waiting" : "offline", kind, attempt: c.attempts + 1, retry, leave });
    if (!navigator.onLine) { c.busy = false; return; }
    c.timer = setTimeout(async () => {
      c.timer = undefined;
      if (!current()) return;
      if (!navigator.onLine) {
        c.busy = false;
        useVoiceRecoveryStore.setState({ phase: "offline" });
        return;
      }
      c.attempts++;
      logToServer("info", "voice_recovery", { stage: kind, attempt: c.attempts, outcome: "starting" });
      let failure: VoiceFailureKind = "connection";
      let response = null;
      try { response = await useVoiceStore.getState().refreshVoiceToken(channel, true); }
      catch (error) { failure = voiceFailureKind(error, "connection"); }
      if (!current()) return;
      c.busy = false;
      if (!response || !useVoiceStore.getState()._wsSend) { scheduleRef.current(failure); return; }
      // A new restart identity rebuilds the Room, key provider and worker even
      // when the server returns identical credentials.
      setRestartId(value => value + 1);
      useVoiceRecoveryStore.setState({ phase: "connecting" });
      useVoiceStore.getState()._wsSend?.("voice_join", { channel_id: channel });
    }, DELAYS[c.attempts]);
  }, [clear, isNativeVoice, leave]);
  useEffect(() => { scheduleRef.current = schedule; }, [schedule]);

  useEffect(() => {
    const cancel = () => reset();
    const unsubscribe = useVoiceStore.subscribe((next, previous) => {
      if (next.currentVoiceChannelId !== previous.currentVoiceChannelId
        || next._joinGeneration !== previous._joinGeneration || next.wasReplaced) cancel();
    });
    const owner = subscribeAuthOwnerChanges(cancel), auth = subscribeAuthGenerationChanges(cancel);
    const online = () => {
      const r = useVoiceRecoveryStore.getState();
      if (r.phase === "offline") scheduleRef.current(r.kind);
    };
    const offline = () => {
      const r = useVoiceRecoveryStore.getState();
      if (r.phase === "waiting") { clear(); useVoiceRecoveryStore.setState({ phase: "offline" }); }
    };
    window.addEventListener("online", online); window.addEventListener("offline", offline);
    return () => {
      unsubscribe(); owner(); auth();
      window.removeEventListener("online", online); window.removeEventListener("offline", offline);
      reset();
    };
  }, [clear, reset]);

  const handleDisconnected = useCallback((reason?: DisconnectReason) => {
    if (reason === DisconnectReason.CLIENT_INITIATED) return;
    if (reason === DisconnectReason.PARTICIPANT_REMOVED || reason === DisconnectReason.ROOM_DELETED) {
      schedule("access"); return;
    }
    schedule("connection");
  }, [schedule]);
  const handleFailure = useCallback((error: unknown) => schedule(voiceFailureKind(error)), [schedule]);
  const handleConnectionError = useCallback((error: unknown) => {
    if (error instanceof Error && error.message.includes("Client initiated")) return;
    schedule(voiceFailureKind(error, "connection"));
  }, [schedule]);
  const markReady = useCallback((ready: boolean) => {
    const c = control.current;
    clearTimeout(c.stable); c.stable = undefined;
    if (!ready) return;
    clearTimeout(c.timer); c.timer = undefined; c.busy = false;
    useVoiceRecoveryStore.setState({ phase: "idle" });
    logToServer("info", "voice_recovery", { stage: "encrypted_ready", attempt: c.attempts, outcome: "connected" });
    c.stable = setTimeout(() => { c.attempts = 0; }, 30_000);
  }, []);
  return { handleDisconnected, handleFailure, handleConnectionError, markReady, restartId,
    suspended: phase === "waiting" || phase === "offline" || phase === "failed" };
}
