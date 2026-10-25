import {ownsP2PCapture}from "./p2pCaptureOwner";
import { useVoiceStore } from "../stores/voiceStore";
import { useP2PCallStore } from "../stores/p2pCallStore";
/** Conservative capture exclusion; never terminates or mutates another call. */
export function privateCaptureConflict():boolean {
 return !!useVoiceStore.getState().currentVoiceChannelId || ownsP2PCapture(useP2PCallStore.getState().activeCall);
}
