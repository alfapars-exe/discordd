import { getAuthGeneration } from "../api/client";
import { useVoiceShortcutAction } from "./useVoiceShortcutAction";
import { useAuthStore } from "../stores/authStore";
import { useDMStore } from "../stores/dmStore";
import { useP2PCallStore } from "../stores/p2pCallStore";
import { useUIStore } from "../stores/uiStore";

type DMCallShortcutOptions = {
  channelId: string;
  ownerId: string | undefined;
  otherUserId: string | undefined;
  otherUserName: string;
  isSelf: boolean;
  authGeneration: number;
};

/** Start a voice call with the peer in the active DM, or return to that call if it already exists. */
export function useDMCallShortcut({ channelId, ownerId, otherUserId, otherUserName, isSelf, authGeneration }: DMCallShortcutOptions): void {
  useVoiceShortcutAction("group-call-start", () => {
    const destination = useUIStore.getState().destination;
    const currentUserId = useAuthStore.getState().user?.id;
    if (!ownerId || !otherUserId || isSelf || currentUserId !== ownerId || getAuthGeneration() !== authGeneration ||
        destination.type !== "dm" || destination.channelId !== channelId) return false;
    const currentDM = useDMStore.getState().channels.find((item) => item.id === channelId);
    if (!currentDM || currentDM.other_user.id !== otherUserId) return false;

    const callStore = useP2PCallStore.getState();
    const existing = callStore.activeCall;
    if (existing) {
      const samePeer = (existing.caller_id === ownerId && existing.receiver_id === otherUserId) ||
        (existing.receiver_id === ownerId && existing.caller_id === otherUserId);
      if (!samePeer) return false;
      useUIStore.getState().openTab(existing.id, "p2p", otherUserName);
      return true;
    }
    if (!callStore._sendWS) return false;
    callStore.initiateCall(otherUserId, "voice");
    return true;
  });
}
