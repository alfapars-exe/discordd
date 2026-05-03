/**
 * useRttPolling — keep voiceStore.rtt fresh while connected to a LiveKit
 * room, so the "Ses Bağlı / 111 ms" indicator in the UI reflects the
 * current network round-trip.
 *
 * Polls every 3s while the room is in Connected state. Two sources, in
 * order of preference:
 *
 *   1. Signal RTT — `engine.client.rtt` is what LiveKit measures over its
 *      own signaling websocket. Cheapest read, most responsive.
 *   2. ICE candidate-pair RTT — falls back to standard WebRTC getStats()
 *      and pulls the nominated candidate-pair's currentRoundTripTime
 *      (seconds; multiplied by 1000 for ms display).
 *
 * Both reads are wrapped in try/catch because the engine internals aren't
 * a stable LiveKit API surface — they may shift between SDK versions and
 * we'd rather degrade silently than crash the voice connection.
 *
 * Was previously inline in VoiceStateManager.tsx.
 */

import { useEffect } from "react";
import { ConnectionState, type Room } from "livekit-client";

import { useVoiceStore } from "../stores/voiceStore";

const POLL_INTERVAL_MS = 3000;

export function useRttPolling(room: Room): void {
  useEffect(() => {
    if (room.state !== ConnectionState.Connected) return;
    let cancelled = false;

    async function pollRtt() {
      if (cancelled) return;
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const engine = (room as any).engine;

        const signalRtt = engine?.client?.rtt as number | undefined;
        if (typeof signalRtt === "number" && signalRtt > 0) {
          useVoiceStore.getState().setRtt(Math.round(signalRtt));
          return;
        }

        const pc = engine?.pcManager?.subscriber?.pc as RTCPeerConnection | undefined;
        if (!pc) return;
        const stats = await pc.getStats();
        if (cancelled) return;

        stats.forEach((report: Record<string, unknown>) => {
          if (
            report.type === "candidate-pair" &&
            report.nominated === true &&
            typeof report.currentRoundTripTime === "number" &&
            report.currentRoundTripTime > 0
          ) {
            useVoiceStore.getState().setRtt(
              Math.round((report.currentRoundTripTime as number) * 1000),
            );
          }
        });
      } catch {
        /* engine/client not ready yet — try again next interval */
      }
    }

    pollRtt();
    const interval = setInterval(pollRtt, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [room, room.state]);
}
