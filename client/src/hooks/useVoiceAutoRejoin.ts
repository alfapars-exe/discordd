import { useCallback, useEffect, useRef, useState } from "react";
import { DisconnectReason } from "livekit-client";
import { useVoiceStore } from "../stores/voiceStore";
import { useVoiceRecoveryStore } from "../stores/voiceRecoveryStore";
import { voiceFailureKind, type VoiceFailureKind } from "../audio/voiceFailure";
import { getAuthSessionOwner, getAuthSessionSnapshot, subscribeAuthGenerationChanges, subscribeAuthOwnerChanges } from "../api/authSessionEvents";
import { logToServer } from "../api/clientLog";

const DELAYS = [200, 3000, 7000];
// A server-side race can evict a participant from a room it has only just
// rejoined: the eviction for its own earlier departure from that channel
// lands late. Within this window after the join committed that is retried.
const FRESH_JOIN_EVICTION_MS = 10_000;
// Only a departure by this client at most this long before the join committed
// can still have such an eviction in flight. Without one the removal is a
// moderator disconnect or another session of the account taking voice over,
// and retrying would undo it.
const RECENT_DEPARTURE_MS = 10_000;

/** Whether the server lists this account in a voice channel other than `channelId`. */
function listedInAnotherChannel(channelId: string): boolean {
  const own = getAuthSessionOwner();
  if (!own) return false;
  return Object.entries(useVoiceStore.getState().voiceStates)
    .some(([id, states]) => id !== channelId && states.some(state => state.user_id === own));
}

/** One recovery owner for terminal SDK disconnects and fail-closed E2EE errors. */
export function useVoiceAutoRejoin(isNativeVoice: boolean) {
  const [restartId, setRestartId] = useState(0);
  const phase = useVoiceRecoveryStore(s => s.phase);
  // evicted: this recovery answers a server removal (PARTICIPANT_REMOVED)
  // taken for the late eviction of this client's own departure.
  const control = useRef({ attempts: 0, busy: false, generation: 0, evicted: false,
    timer: undefined as ReturnType<typeof setTimeout> | undefined,
    stable: undefined as ReturnType<typeof setTimeout> | undefined });
  const clear = useCallback(() => {
    const c = control.current;
    c.generation++; c.busy = false;
    clearTimeout(c.timer); clearTimeout(c.stable);
    c.timer = undefined; c.stable = undefined;
  }, []);
  const reset = useCallback(() => {
    clear(); control.current.attempts = 0; control.current.evicted = false;
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
      // The removal may not have been this client's own late eviction after
      // all: another session of the account joining a different channel
      // evicts this one the same way, and the server sends nothing that says
      // so. It does broadcast that join before it dispatches the eviction, so
      // by now — a timer and a token round trip after the removal — the
      // account is listed in the other channel. Rejoining here would move the
      // account back and evict the newer session in turn.
      if (c.evicted && listedInAnotherChannel(channel)) { scheduleRef.current("access"); return; }
      if (!response || !useVoiceStore.getState()._wsSend) { scheduleRef.current(failure); return; }
      // A new restart identity rebuilds the Room, key provider and worker even
      // when the server returns identical credentials.
      setRestartId(value => value + 1);
      useVoiceRecoveryStore.setState({ phase: "connecting" });
      // Same payload as a normal join: the server may build a fresh state
      // from it, which must not announce a muted user as unmuted.
      const { _wsSend: send, isMuted, isDeafened } = useVoiceStore.getState();
      send?.("voice_join", { channel_id: channel, is_muted: isMuted, is_deafened: isDeafened });
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
    if (reason === DisconnectReason.ROOM_DELETED) { schedule("access"); return; }
    if (reason === DisconnectReason.PARTICIPANT_REMOVED) {
      // Terminal, except right after the current join committed to a channel
      // this client had just left. Recovery refreshes the token first, so a
      // kick, ban or timeout still ends as "access" when the server refuses
      // it (403/404); a voice disconnect is not refused, hence the departure
      // requirement.
      const { _joinCommit: commit, _joinGeneration: generation, currentVoiceChannelId: channel, _departures: departures } = useVoiceStore.getState();
      const fresh = commit && commit.generation === generation ? commit : null;
      const elapsed = fresh ? Date.now() - fresh.at : -1;
      const departedAt = channel ? departures[channel] : undefined;
      const sinceDeparture = fresh && departedAt !== undefined ? fresh.at - departedAt : -1;
      const raced = elapsed >= 0 && elapsed < FRESH_JOIN_EVICTION_MS
        && sinceDeparture >= 0 && sinceDeparture < RECENT_DEPARTURE_MS;
      // The timings alone cannot tell this from another session's takeover;
      // the recovery checks the server's listing before it rejoins (above).
      if (raced) control.current.evicted = true;
      schedule(raced ? "connection" : "access"); return;
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
    clearTimeout(c.timer); c.timer = undefined; c.busy = false; c.evicted = false;
    useVoiceRecoveryStore.setState({ phase: "idle" });
    logToServer("info", "voice_recovery", { stage: "encrypted_ready", attempt: c.attempts, outcome: "connected" });
    c.stable = setTimeout(() => { c.attempts = 0; }, 30_000);
  }, []);
  return { handleDisconnected, handleFailure, handleConnectionError, markReady, restartId,
    suspended: phase === "waiting" || phase === "offline" || phase === "failed" };
}
