import { Track, type LocalParticipant, type LocalVideoTrack, type TrackPublishOptions } from "livekit-client";
import { captureAdmissionCurrent, subscribeCaptureAdmission } from "../audio/microphoneAdmission";
import { privateScreenConstraints, type PrivateScreenQuality, type ScreenMetrics } from "../utils/privateScreenQuality";

export type ScreenShareUpdate = {
  settings: PrivateScreenQuality;
  publish: TrackPublishOptions;
  contentHint: "motion" | "detail";
  display?: ScreenMetrics | null;
};

const intentionalUnpublishes = new WeakSet<LocalVideoTrack>();
export const isScreenShareReconfiguring = (track: unknown) =>
  typeof track === "object" && track !== null && intentionalUnpublishes.has(track as LocalVideoTrack);

function encodingKey(config: ScreenShareUpdate) {
  const p = config.publish;
  return JSON.stringify([privateScreenConstraints(config.settings, config.display), p.videoCodec,
    p.screenShareEncoding, p.screenShareSimulcastLayers, p.simulcast, p.scalabilityMode, p.backupCodec]);
}

/** Owns the captured source even while it is absent from the SDK publication map.
 * SDK encoding caches and dynacast are rebuilt through public publish APIs; audio
 * is never unpublished. Codec/rate changes may briefly interrupt remote video.
 */
export class LiveKitScreenShareUpdater {
  private disposed = false;
  private revision = 0;
  private updates: Promise<unknown> = Promise.resolve();
  private unsubscribe: () => void;
  private config: ScreenShareUpdate;
  private participant: LocalParticipant;
  readonly track: LocalVideoTrack;
  private scope: () => boolean;
  private suspended = false;
  private disposeListeners = new Set<() => void>();

  constructor(
    participant: LocalParticipant,
    track: LocalVideoTrack,
    scope: () => boolean,
    initial: ScreenShareUpdate,
  ) {
    this.participant = participant;
    this.track = track;
    this.scope = scope;
    this.config = initial;
    // A suspend (SDK reconnect / key rotation on the same Room) keeps the
    // captured source: admission has already paused it in place and restores
    // it only after encryption is re-admitted. Retirement stops it.
    this.unsubscribe = subscribeCaptureAdmission(participant, reason => {
      if (reason === "suspend" && !this.disposed) { this.suspended = true; ++this.revision; }
      else this.dispose();
    });
    track.mediaStreamTrack.addEventListener("ended", this.ended);
  }

  private ended = () => this.dispose();
  private current = () => !this.disposed && this.scope() && captureAdmissionCurrent(this.participant)
    && this.track.mediaStreamTrack.readyState !== "ended";

  get active() { return this.current(); }
  /** Source is alive but its Room is re-admitting encryption. */
  get isSuspended() { return this.suspended && !this.disposed && this.track.mediaStreamTrack.readyState !== "ended"; }

  /** Rebinds a suspended source to its next owner once admission reopened. */
  resume(scope: () => boolean): boolean {
    if (this.disposed || this.track.mediaStreamTrack.readyState === "ended" || !captureAdmissionCurrent(this.participant)) return false;
    this.scope = scope;
    this.suspended = false;
    return true;
  }

  onDispose(listener: () => void): () => void {
    if (this.disposed) { listener(); return () => {}; }
    this.disposeListeners.add(listener);
    return () => { this.disposeListeners.delete(listener); };
  }

  update(next: ScreenShareUpdate): Promise<boolean> {
    const revision = ++this.revision;
    const operation = this.updates.catch(() => {}).then(async () => {
      // Skip superseded work before it starts. Once unpublish starts, finish the
      // transaction unless the source/session is retired, then apply the latest.
      if (revision !== this.revision || !this.current()) return false;
      return this.apply(next);
    });
    this.updates = operation;
    return operation;
  }

  private async apply(next: ScreenShareUpdate): Promise<boolean> {
    const raw = this.track.mediaStreamTrack;
    const previous = this.config;
    const oldOptions = { ...previous.publish, ...this.track.publishOptions };
    // SDK-generated L1T3 must not become an explicit request for RID simulcast
    // on a later VP9 publish. Keep requested and negotiated options separate.
    if (previous.publish.scalabilityMode === undefined) delete oldOptions.scalabilityMode;
    const options: TrackPublishOptions = { ...oldOptions, ...next.publish, source: Track.Source.ScreenShare };
    if (next.publish.scalabilityMode === undefined) delete options.scalabilityMode;
    const previousHint = raw.contentHint;
    const previousConstraints = raw.getConstraints();
    const wasEnabled = raw.enabled;
    const republish = encodingKey(previous) !== encodingKey(next);
    let unpublished = false;
    try {
      if (republish) {
        await raw.applyConstraints(privateScreenConstraints(next.settings, next.display));
        if (!this.current()) return this.abandon(unpublished);
        // Protect only this video's intentional unpublish event. Real ended
        // events are still observed on the retained raw source during the gap.
        intentionalUnpublishes.add(this.track);
        raw.enabled = false;
        unpublished = true;
        await this.participant.unpublishTrack(this.track, false);
        if (!this.current()) return this.abandon(unpublished);
        raw.contentHint = next.contentHint;
        await this.participant.publishTrack(this.track, options);
        if (!this.current()) return this.abandon(unpublished);
      } else {
        // LiveKit 2.23 uses motion for VP9 screen SVC as a Chromium workaround.
        // Do not undo it when the user changes only the detail profile.
        raw.contentHint = (this.track.publishOptions?.videoCodec ?? options.videoCodec) === "vp9" ? "motion" : next.contentHint;
        if (options.degradationPreference) await this.track.setDegradationPreference(options.degradationPreference);
        if (!this.current()) return this.abandon(unpublished);
      }
      if (!republish) this.track.publishOptions = { ...this.track.publishOptions, degradationPreference: options.degradationPreference };
      this.config = next;
      raw.enabled = wasEnabled;
      return true;
    } catch (error) {
      if (!this.current()) return this.abandon(unpublished);
      // Recover the old publication without reacquiring the screen. If recovery
      // itself fails, stop the owned source rather than leave an orphan capture.
      try {
        await raw.applyConstraints(previousConstraints);
        if (!this.current()) return this.abandon(unpublished);
        raw.contentHint = previousHint;
        if (unpublished) {
          await this.participant.unpublishTrack(this.track, false);
          if (!this.current()) return this.abandon(unpublished);
          await this.participant.publishTrack(this.track, oldOptions);
        } else if (oldOptions.degradationPreference) {
          await this.track.setDegradationPreference(oldOptions.degradationPreference);
        }
        if (!this.current()) return this.abandon(unpublished);
        if (!unpublished) this.track.publishOptions = { ...this.track.publishOptions, degradationPreference: oldOptions.degradationPreference };
        raw.enabled = wasEnabled;
      } catch {
        this.dispose();
      }
      throw error;
    } finally {
      intentionalUnpublishes.delete(this.track);
    }
  }

  // A suspension interrupts only work that has not yet unpublished the source;
  // a source already absent from the SDK cannot be republished until re-admission.
  private abandon(unpublished: boolean) {
    if (!this.isSuspended || unpublished) this.dispose();
    return false;
  }

  dispose() {
    // Repeat unpublish after a late publish resolves, even if already disposed.
    if (!this.disposed) {
      this.disposed = true;
      ++this.revision;
      this.unsubscribe();
      this.track.mediaStreamTrack.removeEventListener("ended", this.ended);
      this.track.mediaStreamTrack.enabled = false;
      this.track.stop();
      const listeners = [...this.disposeListeners];
      this.disposeListeners.clear();
      listeners.forEach(listener => listener());
    }
    void this.participant.unpublishTrack(this.track).catch(() => {});
  }
}
