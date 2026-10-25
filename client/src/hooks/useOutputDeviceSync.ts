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

import { useEffect, useRef } from "react";
import { ConnectionState, RoomEvent, type Room } from "livekit-client";

import { useVoiceStore } from "../stores/voiceStore";

export function useOutputDeviceSync(room: Room): void {
  const outputDevice = useVoiceStore((s) => s.outputDevice);
  const routing = useRef({ room, queue: Promise.resolve(), revision: 0 });

  useEffect(() => {
    if (routing.current.room !== room) routing.current = { room, queue: Promise.resolve(), revision: 0 };
    const route = routing.current;
    let active = true;
    async function applyOutputDevice() {
      const revision = ++route.revision;
      const current = () => active && routing.current === route && route.revision === revision;
      const operation = route.queue.catch(() => {}).then(async () => {
        if (!current()) return;
        try {
          // The empty preference means the system default, not "leave the
          // previously selected speaker active".
          await room.switchActiveDevice("audiooutput", outputDevice || "default");
        } catch (err) {
          // Queue the latest choice after an in-flight switch. A superseded
          // failure must not restore the default over the new preference.
          if (!current()) return;
          if (outputDevice && outputDevice !== "default") {
            try {
              await room.switchActiveDevice("audiooutput", "default");
              return;
            } catch {
              // Keep the call alive if no routable output exists.
            }
          }
          if (current()) console.warn("[useOutputDeviceSync] Output device unavailable; using browser default.", err);
        }
      });
      route.queue = operation;
      await operation;
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
      active = false;
      room.off(RoomEvent.Connected, handleConnected);
      room.off(RoomEvent.Reconnected, handleConnected);
    };
  }, [room, outputDevice]);
}
