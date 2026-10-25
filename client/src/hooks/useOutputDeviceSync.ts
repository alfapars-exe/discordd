/**
 * useOutputDeviceSync — apply the user's chosen audio output device (sinkId)
 * to all LiveKit audio elements, both now and on every (re)connect.
 *
 * Why apply on connect: LiveKit's `switchActiveDevice("audiooutput", id)`
 * stores the preference on the Room AND walks existing audio elements. New
 * audio elements created later (e.g. when a remote participant joins or a
 * track resubscribes after reconnect) inherit it. So we re-call on each
 * Connected/Reconnected event to handle the case where the Room was
 * recreated or audio elements were re-mounted.
 *
 * Was previously ~30 lines inline in VoiceStateManager.tsx.
 */

import { useEffect } from "react";
import { ConnectionState, RoomEvent, type Room } from "livekit-client";

import { useVoiceStore } from "../stores/voiceStore";

export function useOutputDeviceSync(room: Room): void {
  const outputDevice = useVoiceStore((s) => s.outputDevice);

  useEffect(() => {
    async function applyOutputDevice() {
      try {
        // The empty preference means the system default, not "leave the
        // previously selected speaker active".
        await room.switchActiveDevice("audiooutput", outputDevice || "default");
      } catch (err) {
        // A persisted USB/Bluetooth device can disappear between sessions.
        // Restore the browser/system default so a stale sink never prevents
        // the call from continuing with audio.
        if (outputDevice && outputDevice !== "default") {
          try {
            await room.switchActiveDevice("audiooutput", "default");
            return;
          } catch {
            // The browser may have no routable output at all; keep the call
            // alive and let LiveKit use its normal fallback.
          }
        }
        console.warn("[useOutputDeviceSync] Output device unavailable; using browser default.", err);
      }
    }

    if (room.state === ConnectionState.Connected) {
      applyOutputDevice();
    }

    function handleConnected() {
      applyOutputDevice();
    }

    room.on(RoomEvent.Connected, handleConnected);
    room.on(RoomEvent.Reconnected, handleConnected);

    return () => {
      room.off(RoomEvent.Connected, handleConnected);
      room.off(RoomEvent.Reconnected, handleConnected);
    };
  }, [room, outputDevice]);
}
