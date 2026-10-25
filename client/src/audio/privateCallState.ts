import { useVoiceStore } from "../stores/voiceStore";
import { useP2PCallStore } from "../stores/p2pCallStore";
/** Conservative capture exclusion; never terminates or mutates another call. */
export function privateCaptureConflict():boolean {
 return !!useVoiceStore.getState().currentVoiceChannelId || !!useP2PCallStore.getState().activeCall;
}
