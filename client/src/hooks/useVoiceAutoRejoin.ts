/**
 * useVoiceAutoRejoin — produce the LiveKit `onDisconnected` handler that
 * decides whether a disconnect should drop the user from voice or trigger
 * an automatic rejoin with a fresh token.
 *
 * The rejoin policy:
 *
 *   - CLIENT_INITIATED: ignored. Our own code already cleared state before
 *     triggering the disconnect (explicit leave, force-move token swap,
 *     auto-rejoin retry, kick handler). A second cleanup here would race
 *     any in-flight join — bumping `_joinGeneration` while a join is
 *     mid-flight reproduces the force-move bug.
 *
 *   - DUPLICATE_IDENTITY: usually not "another device joined" — that's
 *     handled separately via WS `voice_replaced` (which sets `wasReplaced`
 *     in the store). What hits this branch is almost always the SDK's
 *     own full-reconnect flow: signal WS dropped → resume failed → SDK
 *     opens a new connection → SFU evicts the old one → this fires on
 *     the old session. Treat as server-initiated and rejoin.
 *
 *   - `wasReplaced`: another session genuinely took over voice. Clear the
 *     flag and skip rejoin so we don't ping-pong.
 *
 *   - Any other reason while `currentVoiceChannelId` is set: server- or
 *     SDK-initiated. Hot-swap the token (refreshVoiceToken keeps connect=
 *     true the whole time, avoiding the connect=false→true thrash that
 *     made LiveKitRoom create two Room instances and consume rejoin
 *     attempts in pairs).
 *
 *   - After MAX_REJOIN_ATTEMPTS, fall through to a clean leave.
 *
 * Counter management: the rejoin counter resets when the user explicitly
 * joins a *different* channel (channel id changed AND non-null). It does
 * NOT reset on null-then-same-channel transitions, so an auto-rejoin's
 * leave→rejoin doesn't get free retries.
 *
 * iOS native voice short-circuits at the top — the JS SDK isn't actually
 * driving the connection there, so all JS disconnect events are noise.
 *
 * Was previously ~110 lines inline in VoiceProvider.tsx.
 */

import { useCallback, useEffect, useRef } from "react";
import { DisconnectReason } from "livekit-client";

import { useVoiceStore } from "../stores/voiceStore";

const MAX_REJOIN_ATTEMPTS = 2;

export function useVoiceAutoRejoin(isNativeVoice: boolean): {
  handleDisconnected: (reason?: DisconnectReason) => void;
} {
  const leaveVoiceChannel = useVoiceStore((s) => s.leaveVoiceChannel);

  // Tracks how many times we've auto-rejoined the *current* channel without
  // a successful stable connection in between. Reset on explicit channel
  // change.
  const rejoinAttemptsRef = useRef(0);

  // Last non-null channel id we've seen. Used to detect "user joined a
  // different channel" events that should reset the counter.
  const prevChannelRef = useRef<string | null>(null);

  // Generation token. Incremented on unmount so any in-flight
  // refreshVoiceToken().then(...) chain captured a stale generation and
  // can detect that it's running after the hook tore down — without this
  // a promise resolving post-unmount would run leaveVoiceChannel() or
  // _wsSend() against a defunct closure.
  const generationRef = useRef(0);
  useEffect(() => {
    return () => {
      generationRef.current += 1;
    };
  }, []);

  // Reset rejoin counter when the user explicitly joins a different channel.
  // We only update prevChannelRef on non-null channel ids so a null →
  // same-channel transition (which is what auto-rejoin produces) doesn't
  // count as "joined a different channel" and reset the counter.
  useEffect(() => {
    const channelId = useVoiceStore.getState().currentVoiceChannelId;
    if (channelId && channelId !== prevChannelRef.current) {
      rejoinAttemptsRef.current = 0;
    }
    if (channelId) {
      prevChannelRef.current = channelId;
    }
  });

  const handleDisconnected = useCallback(
    (reason?: DisconnectReason) => {
      if (isNativeVoice) return;

      const { currentVoiceChannelId, _wsSend, wasReplaced } =
        useVoiceStore.getState();

      console.warn("[useVoiceAutoRejoin] onDisconnected fired", {
        reason,
        reasonName: reason !== undefined ? DisconnectReason[reason] : "undefined",
        timestamp: new Date().toISOString(),
        currentVoiceChannelId,
        wasReplaced,
        rejoinAttempts: rejoinAttemptsRef.current,
        maxAttempts: MAX_REJOIN_ATTEMPTS,
      });

      if (wasReplaced) {
        console.warn("[useVoiceAutoRejoin] wasReplaced=true -> skip rejoin");
        useVoiceStore.setState({ wasReplaced: false });
        return;
      }

      if (reason === DisconnectReason.CLIENT_INITIATED) {
        console.warn("[useVoiceAutoRejoin] CLIENT_INITIATED -> ignore");
        return;
      }

      if (reason === DisconnectReason.DUPLICATE_IDENTITY) {
        console.warn(
          "[useVoiceAutoRejoin] DUPLICATE_IDENTITY -> treating as server-initiated, will auto-rejoin",
        );
        // fall through
      }

      if (currentVoiceChannelId) {
        if (rejoinAttemptsRef.current < MAX_REJOIN_ATTEMPTS) {
          rejoinAttemptsRef.current += 1;
          const channelToRejoin = currentVoiceChannelId;
          console.warn(
            `[useVoiceAutoRejoin] Auto-rejoin attempt ${rejoinAttemptsRef.current}/${MAX_REJOIN_ATTEMPTS} -> ${channelToRejoin}`,
          );

          // Capture generation at dispatch time so a late-arriving
          // resolve after unmount is a no-op instead of touching stale
          // store state.
          const myGeneration = generationRef.current;
          useVoiceStore
            .getState()
            .refreshVoiceToken(channelToRejoin)
            .then((tokenResp) => {
              if (generationRef.current !== myGeneration) return;
              if (tokenResp && _wsSend) {
                console.warn("[useVoiceAutoRejoin] Auto-rejoin SUCCESS");
                _wsSend("voice_join", { channel_id: channelToRejoin });
              } else {
                console.warn("[useVoiceAutoRejoin] Auto-rejoin FAILED", {
                  hasTokenResp: !!tokenResp,
                  hasWsSend: !!_wsSend,
                });
                leaveVoiceChannel();
              }
            });
          return;
        }

        console.warn("[useVoiceAutoRejoin] Max rejoin attempts reached, giving up");
      }

      console.warn("[useVoiceAutoRejoin] Falling through to leaveVoiceChannel()");
      leaveVoiceChannel();
    },
    [isNativeVoice, leaveVoiceChannel],
  );

  return { handleDisconnected };
}
