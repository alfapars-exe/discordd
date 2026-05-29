/**
 * isHarmlessVoiceRace — true for the expected fallout when a LiveKit call
 * (e.g. setMicrophoneEnabled) races the SDK engine tearing down. These occur
 * when a room.state check loses to the actual lifecycle; surfacing them as
 * console errors makes real failures hard to spot, so callers swallow them.
 *
 * Matched by error class name (PublishTrackError / ConnectionError) AND by
 * message substring, because different SDK versions phrase the message
 * differently. Extracted from useInitialRoomSync so any voice hook can share
 * the same guard.
 */
export function isHarmlessVoiceRace(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes("engine not connected") ||
    msg.includes("client initiated disconnect") ||
    err.name === "PublishTrackError" ||
    err.name === "ConnectionError"
  );
}
