export type VoiceMuteIntent = { isMuted: boolean; isDeafened: boolean; muteBeforeDeafen: boolean | null };
/** Legacy deafened state has no trustworthy prior intent: keep its mic muted. */
export function normalizeVoiceMuteIntent(value: unknown): VoiceMuteIntent {
  const parsed = value && typeof value === "object" ? value as Partial<VoiceMuteIntent> : {};
  const deaf = parsed.isDeafened === true;
  return { isMuted: deaf || parsed.isMuted === true, isDeafened: deaf,
    muteBeforeDeafen: deaf ? typeof parsed.muteBeforeDeafen === "boolean" ? parsed.muteBeforeDeafen : true : null };
}
export function toggleVoiceMuteIntent(state: VoiceMuteIntent): VoiceMuteIntent {
  if (state.isDeafened) return { isMuted: true, isDeafened: true, muteBeforeDeafen: !(state.muteBeforeDeafen ?? true) };
  return { isMuted: !state.isMuted, isDeafened: false, muteBeforeDeafen: null };
}
export function toggleVoiceDeafenIntent(state: VoiceMuteIntent): VoiceMuteIntent {
  return state.isDeafened
    ? { isMuted: state.muteBeforeDeafen ?? true, isDeafened: false, muteBeforeDeafen: null }
    : { isMuted: true, isDeafened: true, muteBeforeDeafen: state.isMuted };
}
