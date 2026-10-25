import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { RoomEvent, type Room } from "livekit-client";
import { useTranslation } from "react-i18next";
import { getAuthSessionSnapshot, subscribeAuthGenerationChanges, subscribeAuthOwnerChanges } from "../../api/authSessionEvents";
import { subscribeCaptureAdmission } from "../../audio/microphoneAdmission";
import { useGroupDMStore } from "../../stores/groupDMStore";
import { useVoiceStore } from "../../stores/voiceStore";
import { useScreenSharePublishDefaults } from "../../hooks/useScreenSharePublishDefaults";
import { useDisplayInfo } from "../../hooks/useDisplayInfo";
import { GroupScreenShareSession } from "./GroupScreenShareSession";
import PrivateScreenQualityControls from "../voice/PrivateScreenQualityControls";

export default function GroupScreenShareControl({ room, groupId, keyEpoch, isCurrentSession }: { room: Room; groupId: string; keyEpoch?: number; isCurrentSession?: () => boolean }) {
  const { t } = useTranslation("voice");
  const defaults = useScreenSharePublishDefaults(), display = useDisplayInfo();
  const latestDefaults = useRef(defaults); useLayoutEffect(() => { latestDefaults.current = defaults; }, [defaults]);
  const session = useRef<GroupScreenShareSession | null>(null), mounted = useRef(false);
  const [sharing, setSharing] = useState(false), [pending, setPending] = useState(false), [error, setError] = useState(false);
  const [owner] = useState(getAuthSessionSnapshot);
  const latest = useRef(isCurrentSession); useLayoutEffect(() => { latest.current = isCurrentSession; }, [isCurrentSession]);
  const current = () => {
    const auth = getAuthSessionSnapshot(), groups = useGroupDMStore.getState();
    return mounted.current && !!owner.ownerId && auth.ownerId === owner.ownerId && auth.generation === owner.generation
      && groups.ownerId === owner.ownerId && groups.authGeneration === owner.generation
      && groups.groups.some(group => group.id === groupId && group.key_epoch === keyEpoch) && (!latest.current || latest.current());
  };
  const stop = () => { session.current?.dispose(); session.current = null; if (mounted.current) { setSharing(false); setPending(false); } };
  useLayoutEffect(() => { if (isCurrentSession && !isCurrentSession()) stop(); }, [isCurrentSession]);
  useLayoutEffect(() => {
    mounted.current = true;
    const fence = () => { if (!current() || room.localParticipant.permissions?.canPublish !== true) stop(); };
    const close = () => stop();
    const unsubscribers = [useGroupDMStore.subscribe(fence), subscribeAuthGenerationChanges(fence), subscribeAuthOwnerChanges(fence), subscribeCaptureAdmission(room.localParticipant, close)];
    room.on(RoomEvent.Reconnecting, close); room.on(RoomEvent.Disconnected, close); room.on(RoomEvent.ParticipantPermissionsChanged, fence);
    return () => { mounted.current = false; stop(); unsubscribers.forEach(unsubscribe => unsubscribe()); room.off(RoomEvent.Reconnecting, close); room.off(RoomEvent.Disconnected, close); room.off(RoomEvent.ParticipantPermissionsChanged, fence); };
    // Each component is one Room/membership lease; refs provide the live callback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room, groupId, keyEpoch, owner]);
  useEffect(() => {
    const source = session.current;
    void source?.update(useVoiceStore.getState(), defaults.screenSharePublish).catch(() => { if (session.current === source && current()) setError(true); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaults.screenSharePublish, room, groupId, keyEpoch]);
  const toggle = async () => {
    if (session.current) { stop(); return; }
    if (!current()) return;
    const source: GroupScreenShareSession = new GroupScreenShareSession(room, () => session.current === source && current(), display);
    session.current = source; setPending(true); setError(false);
    try {
      const started = await source.start(useVoiceStore.getState(), defaults.screenSharePublish, defaults.screenShareCapture.contentHint);
      if (session.current !== source || !current()) { source.dispose(); return; }
      if (!started) { stop(); setError(true); return; }
      source.onEnded(() => { if (session.current === source) stop(); });
      setSharing(true); setPending(false);
      // A preference changed while the picker was open must apply to this source too.
      await source.update(useVoiceStore.getState(), latestDefaults.current.screenSharePublish);
    } catch { if (session.current === source && current()) { stop(); setError(true); } }
  };
  return <><button type="button" aria-pressed={sharing} onClick={() => void toggle()}>{t("screenShare")}{pending ? "\u2026" : ""}</button>
    <PrivateScreenQualityControls />{error && <span role="alert">{t("screenShareQualityFailed")}</span>}</>;
}
