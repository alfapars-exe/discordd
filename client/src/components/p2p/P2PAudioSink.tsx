/** Sole remote P2P audio owner; stays mounted while the main chat changes. */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useP2PCallStore } from "../../stores/p2pCallStore";
import { useVoiceStore } from "../../stores/voiceStore";
import { useAuthStore } from "../../stores/authStore";
import { getAuthGeneration } from "../../api/client";
import { subscribeAuthGenerationChanges, subscribeAuthOwnerChanges } from "../../api/authSessionEvents";
import { playP2PAudio, type P2PPlayback } from "../../audio/p2pPlayback";

// A retained old stream must not be adopted by another login or replacement
// call, even when the new account happens to be the other participant.
const streamOwners = new WeakMap<MediaStream, { owner: string; generation: number; callId: string; peer: string; connection: RTCPeerConnection | null }>();

const subscribeSession = (changed: () => void) => {
  const generation = subscribeAuthGenerationChanges(changed), owner = subscribeAuthOwnerChanges(changed);
  return () => { generation(); owner(); };
};
const bounded = (value: number, max: number) => Number.isFinite(value) ? Math.max(0, Math.min(max, value)) : 0;
function playbackVolume(peer: string): number {
  const state = useVoiceStore.getState();
  if (state.isDeafened || state.isServerDeafened || state.localMutedUsers[peer]) return 0;
  return bounded(state.masterVolume, 100) / 100 * bounded(state.userVolumes[peer] ?? 100, 200) / 100;
}

export default function P2PAudioSink() {
  const { t } = useTranslation("voice");
  const user = useAuthStore(s => s.user?.id);
  const generation = useSyncExternalStore(subscribeSession, getAuthGeneration, getAuthGeneration);
  const call = useP2PCallStore(s => s.activeCall), stream = useP2PCallStore(s => s.remoteStream), connection = useP2PCallStore(s => s.peerConnection);
  const outputDevice = useVoiceStore(s => s.outputDevice);
  const [retry, setRetry] = useState(0);
  const [status, setStatus] = useState<{ key: string; stream: MediaStream; connection: RTCPeerConnection | null; failed: boolean } | null>(null);
  const player = useRef<P2PPlayback | null>(null);
  const key = JSON.stringify([user, generation, call?.id, call?.caller_id, call?.receiver_id, call?.status, outputDevice, retry]);
  useEffect(() => {
    if (!user || !stream || !connection || !call || call.status !== "active" || (call.caller_id !== user && call.receiver_id !== user)) return;
    const peer = call.caller_id === user ? call.receiver_id : call.caller_id;
    const binding = streamOwners.get(stream);
    if (binding && (binding.owner !== user || binding.generation !== generation || binding.callId !== call.id || binding.peer !== peer || binding.connection !== connection)) return;
    if (!binding) streamOwners.set(stream, { owner: user, generation, callId: call.id, peer, connection });
    let active = true, failed = false;
    const current = () => {
      const state = useP2PCallStore.getState(), live = state.activeCall;
      return active && useAuthStore.getState().user?.id === user && getAuthGeneration() === generation
        && live?.id === call.id && live.status === "active" && live.caller_id === call.caller_id && live.receiver_id === call.receiver_id
        && state.remoteStream === stream && state.peerConnection === connection && useVoiceStore.getState().outputDevice === outputDevice;
    };
    const instance = playP2PAudio(stream, { outputDevice, volume: playbackVolume(peer), isCurrent: current,
      onFailure: () => { if (current()) { failed = true; setStatus({ key, stream, connection, failed: true }); } },
    });
    player.current = instance;
    const stopObsolete = () => { if (!current()) instance.stop(); };
    const unsubscribeCall = useP2PCallStore.subscribe(stopObsolete);
    const unsubscribeOwner = subscribeAuthOwnerChanges(stopObsolete), unsubscribeGeneration = subscribeAuthGenerationChanges(stopObsolete);
    const unsubscribeVoice = useVoiceStore.subscribe(() => { if (!current()) instance.stop(); else instance.setVolume(playbackVolume(peer)); });
    void instance.ready.then(result => { if (current() && !failed) setStatus(result.fallback ? { key, stream, connection, failed: false } : null); }, () => {});
    return () => {
      active = false; unsubscribeCall(); unsubscribeOwner(); unsubscribeGeneration(); unsubscribeVoice();
      instance.stop(); if (player.current === instance) player.current = null;
    };
  }, [user, generation, call, stream, connection, outputDevice, retry, key]);
  if (status?.key !== key || status.stream !== stream || status.connection !== connection) return null;
  return <div className="p2p-audio-status" role={status.failed ? "alert" : "status"}>
    <p>{t(status.failed ? "p2pAudioFailed" : "p2pAudioFallback")}</p>
    {status.failed && <button type="button" onClick={() => setRetry(value => value + 1)}>{t("p2pAudioRetry")}</button>}
  </div>;
}
