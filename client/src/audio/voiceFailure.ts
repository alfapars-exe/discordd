export type VoiceFailureKind = "connection" | "connection_timeout" | "encryption" | "encryption_timeout" | "unsupported" | "access" | "session";

export class VoiceFailure extends Error {
  readonly kind: VoiceFailureKind;
  constructor(kind: VoiceFailureKind) {
    super(kind);
    this.kind = kind;
    this.name = "VoiceFailure";
  }
}

export function voiceFailureKind(error: unknown, fallback: VoiceFailureKind = "encryption"): VoiceFailureKind {
  if (error instanceof VoiceFailure) return error.kind;
  // LiveKit exposes structured reasons; never classify translated free text.
  if (error instanceof Error && error.name === "ConnectionError") {
    const reason = "reasonName" in error ? error.reasonName : undefined;
    if (reason === "NotAllowed") return "access";
    if (reason === "Timeout") return "connection_timeout";
  }
  return fallback;
}
