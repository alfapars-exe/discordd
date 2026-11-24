/**
 * Decides what AppLayout owes the UI when the voice channel changes: closing
 * the voice/screen tabs of the channel that was left and refetching the
 * channel list (hidden channels may become visible via the voice-connected
 * override, or vice versa).
 *
 * A channel switch and a moderator move pass through "no channel" while the
 * new join is pending. Acting on that transient state closed the tab and
 * refetched twice, competing with the join's token request, so the work owed
 * for the channel that was left is carried until the join settles.
 */

export type VoiceChannelTransitionInput = {
  /** Channel seen by the previous run; undefined on the first run (mount). */
  previous: string | null | undefined;
  current: string | null;
  /** Channel a join is in flight for, if any. */
  pending: string | null;
  /** `deferredFrom` returned by the previous run. */
  deferredFrom: string | null;
};

export type VoiceChannelTransition = {
  /** Channel whose voice/screen tabs are stale and must be closed now. */
  closeTabsFor: string | null;
  refetchChannels: boolean;
  /** Channel that was left and whose close + refetch are still owed. */
  deferredFrom: string | null;
};

const NOTHING: VoiceChannelTransition = { closeTabsFor: null, refetchChannels: false, deferredFrom: null };

export function resolveVoiceChannelTransition(input: VoiceChannelTransitionInput): VoiceChannelTransition {
  const { previous, current, pending, deferredFrom } = input;
  // Initial mount — the server cascade refetch handles it.
  if (previous === undefined) return NOTHING;

  if (current) {
    if (previous === current) return NOTHING;
    // A channel committed. Whatever was left on the way here is settled now.
    const left = previous ?? deferredFrom;
    return { closeTabsFor: left && left !== current ? left : null, refetchChannels: true, deferredFrom: null };
  }

  const left = previous ?? deferredFrom;
  if (!left) return NOTHING;
  // Transient gap of a switch or a move: wait for the pending join.
  if (pending) return { closeTabsFor: null, refetchChannels: false, deferredFrom: left };
  // A plain leave, or the pending join ended without a channel.
  return { closeTabsFor: left, refetchChannels: true, deferredFrom: null };
}
