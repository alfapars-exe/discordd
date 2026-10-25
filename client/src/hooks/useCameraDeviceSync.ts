import { useEffect, useRef } from "react";
import { ConnectionState, RoomEvent, type Room } from "livekit-client";
import i18n from "../i18n";
import { useVoiceStore } from "../stores/voiceStore";
import { useToastStore } from "../stores/toastStore";
import { cameraErrorKey } from "../utils/cameraCapture";

/** Serialize device changes so a slow earlier selection cannot win a race. */
export function useCameraDeviceSync(room: Room) {
  const device = useVoiceStore((s) => s.cameraDevice);
  const pending = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => {
    let cancelled = false;
    const sync = () => {
      pending.current = pending.current.then(async () => {
        if (cancelled || room.state !== ConnectionState.Connected) return;
        try {
          // Empty, non-exact constraint restores the browser's default camera.
          const success = await room.switchActiveDevice("videoinput", device, !!device);
          if (!success) throw new DOMException("Camera unavailable", "NotFoundError");
        } catch (error) {
          if (!cancelled) useToastStore.getState().addToast("error", i18n.t(`settings:${cameraErrorKey(error)}`));
        }
      });
    };
    sync();
    room.on(RoomEvent.Connected, sync);
    room.on(RoomEvent.Reconnected, sync);
    return () => {
      cancelled = true;
      room.off(RoomEvent.Connected, sync);
      room.off(RoomEvent.Reconnected, sync);
    };
  }, [room, device]);
}
