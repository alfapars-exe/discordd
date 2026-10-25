/**
 * useP2PCall — P2P call lifecycle management hook.
 *
 * Singleton — must be mounted in AppLayout (like useWebSocket).
 * Responsibilities:
 * 1. Start WebRTC when call is accepted
 * 2. Manage voice channel conflict (leave voice when P2P starts)
 * 3. Open/close P2P UI tab
 * 4. Ringing expiry is owned by the server; no competing local hang-up timer
 * 5. Caller/receiver role routing
 */

import { useEffect, useRef } from "react";
import { useP2PCallStore } from "../stores/p2pCallStore";
import { useAuthStore } from "../stores/authStore";
import { useVoiceStore } from "../stores/voiceStore";
import { useUIStore } from "../stores/uiStore";
import { UI_SHELL_V2 } from "../utils/uiShell";

export function useP2PCall() {
  const prevActiveCallRef = useRef<string | null>(null);

  // ─── Effect: Start WebRTC when call transitions to active ───
  useEffect(() => {
    const unsubscribe = useP2PCallStore.subscribe((state, prev) => {
      const userId = useAuthStore.getState().user?.id;
      if (!userId) return;

      if (
        state.activeCall?.status === "active" &&
        prev.activeCall?.status === "ringing"
      ) {
        const isCaller = state.activeCall.caller_id === userId;

        // Leave voice channel if in one (P2P and voice channel conflict)
        const voiceState = useVoiceStore.getState();
        if (voiceState.currentVoiceChannelId && voiceState._onLeaveCallback) {
          voiceState._onLeaveCallback();
        }

        state.startWebRTC(isCaller);
      }
    });

    return () => unsubscribe();
  }, []);

  // ─── Effect: Open/close UI tab on activeCall change ───
  useEffect(() => {
    const unsubscribe = useP2PCallStore.subscribe((state) => {
      const call = state.activeCall;
      const prevId = prevActiveCallRef.current;

      if (call && call.id !== prevId) {
        prevActiveCallRef.current = call.id;

        const userId = useAuthStore.getState().user?.id;
        const otherUser =
          call.caller_id === userId
            ? call.receiver_display_name ?? call.receiver_username
            : call.caller_display_name ?? call.caller_username;

        useUIStore.getState().openTab(call.id, "p2p", otherUser);
      } else if (!call && prevId) {
        prevActiveCallRef.current = null;
        if (UI_SHELL_V2) {
          const ui = useUIStore.getState();
          if (ui.destination.type === "p2p" && ui.destination.channelId === prevId) ui.closeDestination(prevId);
          return;
        }
        // Find and close the p2p tab
        const panels = useUIStore.getState().panels;
        for (const [panelId, panel] of Object.entries(panels)) {
          const tab = panel.tabs.find((t) => t.type === "p2p");
          if (tab) {
            useUIStore.getState().closeTab(panelId, tab.id);
            break;
          }
        }
      }
    });

    return () => unsubscribe();
  }, []);

  // ─── Effect: Route caller/receiver on call initiate ───
  useEffect(() => {
    const unsubscribe = useP2PCallStore.subscribe((state, prev) => {
      const userId = useAuthStore.getState().user?.id;
      if (!userId) return;

      if (state.activeCall && !prev.activeCall && state.activeCall.status === "ringing") {
        const call = state.activeCall;

        if (call.caller_id === userId) {
          useP2PCallStore.setState({ incomingCall: null });
        }
      }
    });

    return () => unsubscribe();
  }, []);

}
