import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useAudioPlayback } from "@livekit/components-react";
import { ConnectionState, type Room } from "livekit-client";
import { useTranslation } from "react-i18next";
import { getAuthSessionSnapshot } from "../../api/authSessionEvents";
import { useVoiceStore } from "../../stores/voiceStore";

/** A user gesture resumes only the current room's already authorized audio. */
export default function AudioPlaybackRecovery({ room }: { room: Room }) {
  const { t } = useTranslation("voice");
  const { canPlayAudio, startAudio } = useAudioPlayback(room);
  const deafened = useVoiceStore(s => s.isDeafened || s.isServerDeafened);
  const binding = useMemo(() => {
    const voice = useVoiceStore.getState();
    return { room, auth: getAuthSessionSnapshot(), channel: voice.currentVoiceChannelId, join: voice._joinGeneration };
  }, [room]);
  const active = useRef<typeof binding | null>(null);
  const pending = useRef<typeof binding | null>(null);
  const [status, setStatus] = useState<{ binding: typeof binding; pending: boolean; failed: boolean } | null>(null);
  useLayoutEffect(() => {
    active.current = binding;
    return () => { if (active.current === binding) active.current = null; };
  }, [binding]);

  const current = () => {
    const auth = getAuthSessionSnapshot(), voice = useVoiceStore.getState();
    return active.current === binding && room.state === ConnectionState.Connected
      && auth.ownerId === binding.auth.ownerId && auth.generation === binding.auth.generation
      && voice.currentVoiceChannelId === binding.channel && voice._joinGeneration === binding.join
      && !voice.isDeafened && !voice.isServerDeafened;
  };
  const resume = () => {
    if (canPlayAudio !== false || room.canPlaybackAudio !== false || !current() || pending.current === binding) return;
    pending.current = binding;
    setStatus({ binding, pending: true, failed: false });
    // Invoke before any await so Safari receives the actual button gesture.
    let request: Promise<void>;
    try { request = startAudio(); } catch { request = Promise.reject(new Error("Audio playback unavailable")); }
    void request.then(() => {
      if (current()) setStatus({ binding, pending: false, failed: false });
    }, () => {
      if (current()) setStatus({ binding, pending: false, failed: true });
    }).finally(() => { if (pending.current === binding) pending.current = null; });
  };

  if (canPlayAudio !== false || deafened) return null;
  const ownStatus = status?.binding === binding ? status : null;
  return <section className="voice-recovery-status audio-playback-recovery" role="status" aria-live="polite" aria-atomic="true">
    <p>{t(ownStatus?.failed ? "audioPlaybackRetry" : "audioPlaybackBlocked")}</p>
    <button type="button" onClick={resume} disabled={ownStatus?.pending} aria-busy={ownStatus?.pending ?? false}>
      {t(ownStatus?.pending ? "audioPlaybackStarting" : "audioPlaybackStart")}
    </button>
  </section>;
}
