import type { LocalParticipant, LocalTrackPublication } from "livekit-client";
import type { LiveKitScreenShareUpdater } from "./livekitScreenShareUpdate";

/** Longest a suspended share may wait for its Room to re-admit encryption
 * (admission's own connection + acknowledgement deadlines are 30 s + 10 s). */
export const PARKED_SCREEN_SHARE_TIMEOUT_MS = 45_000;

type Parked = {
  updater: LiveKitScreenShareUpdater;
  audio: LocalTrackPublication | null;
  release: () => void;
};
export type ParkedScreenShare = Pick<Parked, "updater" | "audio">;
type ParkOptions = {
  /** Re-evaluated on every `subscribe` notification; false retires the source. */
  wanted: () => boolean;
  subscribe: (changed: () => void) => () => void;
  /** Called once if the parked source is lost instead of adopted. */
  lost: () => void;
};

const parked = new WeakMap<LocalParticipant, Parked>();

function retireAudio(participant: LocalParticipant, audio: LocalTrackPublication | null) {
  const track = audio?.track;
  if (!track) return;
  track.mediaStreamTrack.enabled = false;
  track.stop();
  void participant.unpublishTrack(track).catch(() => {});
}

/**
 * Holds a screen source whose owner unmounted only because its exact Room is
 * re-admitting encryption. The source stays published and paused by admission;
 * it is never re-enabled here. Retirement, a user stop or the deadline stop it.
 */
export function parkScreenShare(participant: LocalParticipant, updater: LiveKitScreenShareUpdater,
  audio: LocalTrackPublication | null, options: ParkOptions) {
  parked.get(participant)?.updater.dispose();
  let settled = false;
  const timer = window.setTimeout(() => updater.dispose(), PARKED_SCREEN_SHARE_TIMEOUT_MS);
  let stopWatching = () => {};
  let stopDisposal = () => {};
  const settle = () => {
    if (settled) return false;
    settled = true;
    if (parked.get(participant) === entry) parked.delete(participant);
    window.clearTimeout(timer);
    stopWatching();
    stopDisposal();
    return true;
  };
  const entry: Parked = { updater, audio, release: () => { settle(); } };
  parked.set(participant, entry);
  stopWatching = options.subscribe(() => { if (!options.wanted()) updater.dispose(); });
  stopDisposal = updater.onDispose(() => {
    if (!settle()) return;
    retireAudio(participant, audio);
    options.lost();
  });
  if (!options.wanted()) updater.dispose();
}

/** The screen-audio publication a parked share still owns, if any. */
export function parkedScreenShareAudio(participant: LocalParticipant) {
  return parked.get(participant)?.audio ?? null;
}

/** Transfers a parked source to a remounted owner; the caller must resume or dispose it. */
export function takeParkedScreenShare(participant: LocalParticipant): ParkedScreenShare | null {
  const entry = parked.get(participant);
  if (!entry) return null;
  entry.release();
  return { updater: entry.updater, audio: entry.audio };
}
