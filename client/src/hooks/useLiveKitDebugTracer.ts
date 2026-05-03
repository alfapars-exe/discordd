/**
 * useLiveKitDebugTracer — verbose console tracing of LiveKit connection
 * lifecycle events. Intended for diagnosing sporadic disconnects.
 *
 * Stamps every transition (ConnectionStateChanged, SignalConnected,
 * Reconnecting, Reconnected, Disconnected, MediaDevicesError, and the
 * local-participant-only ConnectionQualityChanged) with a timestamp and
 * the room snapshot at that moment.
 *
 * Activate by passing `enabled: true`. Default is off so production builds
 * don't spam the console.
 *
 * Was previously inline in VoiceStateManager.tsx and always-on.
 */

import { useEffect } from "react";
import {
  ConnectionState,
  RoomEvent,
  type Participant,
  type Room,
} from "livekit-client";

type Options = {
  enabled?: boolean;
};

export function useLiveKitDebugTracer(room: Room, options: Options = {}): void {
  const { enabled = false } = options;

  useEffect(() => {
    if (!enabled) return;

    function stamp(event: string, extra?: Record<string, unknown>) {
      console.warn(`[LKDebug] ${event}`, {
        timestamp: new Date().toISOString(),
        roomState: room.state,
        sid: room.localParticipant?.sid,
        identity: room.localParticipant?.identity,
        remoteCount: room.remoteParticipants.size,
        ...extra,
      });
    }

    const onConnStateChanged = (state: ConnectionState) =>
      stamp("ConnectionStateChanged", { newState: state });
    const onSignalConnected = () => stamp("SignalConnected");
    const onReconnecting = () => stamp("Reconnecting");
    const onReconnected = () => stamp("Reconnected");
    const onDisconnected = (reason?: unknown) =>
      stamp("Disconnected (room event)", { reason });
    const onMediaDevicesError = (err: Error) =>
      stamp("MediaDevicesError", { message: err.message });
    const onConnectionQualityChanged = (
      quality: unknown,
      participant?: Participant,
    ) => {
      if (participant?.isLocal) {
        stamp("LocalConnectionQualityChanged", { quality });
      }
    };

    room.on(RoomEvent.ConnectionStateChanged, onConnStateChanged);
    room.on(RoomEvent.SignalConnected, onSignalConnected);
    room.on(RoomEvent.Reconnecting, onReconnecting);
    room.on(RoomEvent.Reconnected, onReconnected);
    room.on(RoomEvent.Disconnected, onDisconnected);
    room.on(RoomEvent.MediaDevicesError, onMediaDevicesError);
    room.on(RoomEvent.ConnectionQualityChanged, onConnectionQualityChanged);

    stamp("Listeners attached");

    return () => {
      room.off(RoomEvent.ConnectionStateChanged, onConnStateChanged);
      room.off(RoomEvent.SignalConnected, onSignalConnected);
      room.off(RoomEvent.Reconnecting, onReconnecting);
      room.off(RoomEvent.Reconnected, onReconnected);
      room.off(RoomEvent.Disconnected, onDisconnected);
      room.off(RoomEvent.MediaDevicesError, onMediaDevicesError);
      room.off(RoomEvent.ConnectionQualityChanged, onConnectionQualityChanged);
    };
  }, [room, enabled]);
}
