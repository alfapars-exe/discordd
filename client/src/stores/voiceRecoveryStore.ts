import { create } from "zustand";
import type { VoiceFailureKind } from "../audio/voiceFailure";

export type VoiceRecoveryPhase = "idle" | "waiting" | "offline" | "connecting" | "failed";
type Recovery = {
  phase: VoiceRecoveryPhase;
  kind: VoiceFailureKind;
  attempt: number;
  retry: (() => void) | null;
  leave: (() => void) | null;
};

export const useVoiceRecoveryStore = create<Recovery>(() => ({
  phase: "idle", kind: "connection", attempt: 0, retry: null, leave: null,
}));
