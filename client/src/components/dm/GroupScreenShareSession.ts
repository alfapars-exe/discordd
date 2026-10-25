import { ConnectionState, LocalVideoTrack, Track, type LocalTrack, type Room, type TrackPublishOptions } from "livekit-client";
import { captureAdmissionCurrent } from "../../audio/microphoneAdmission";
import { privateScreenResolution, updatePrivateScreenQuality, type PrivateScreenQuality, type ScreenMetrics } from "../../utils/privateScreenQuality";

const hasEnded = (track: MediaStreamTrack) => track.readyState === "ended";

/** One captured source belongs to one admitted Room, never to a replacement Room. */
export class GroupScreenShareSession {
  private tracks: LocalTrack[] = [];
  private disposed = false;
  private started = false;
  private revision = 0;
  private updates = Promise.resolve();
  private room: Room;
  private scope: () => boolean;
  private display?: ScreenMetrics | null;
  constructor(room: Room, scope: () => boolean, display?: ScreenMetrics | null) { this.room = room; this.scope = scope; this.display = display; }
  private current = () => !this.disposed && this.scope() && this.room.state === ConnectionState.Connected
    && this.room.localParticipant.permissions?.canPublish === true && captureAdmissionCurrent(this.room.localParticipant);
  async start(settings: PrivateScreenQuality, publish: TrackPublishOptions, contentHint: "motion" | "detail") {
    if (this.started || !this.current()) return false;
    this.started = true;
    // Private screen sharing is video-only. It never takes ownership of the guild WASAPI helper.
    const captured = await this.room.localParticipant.createScreenTracks({ audio: false, resolution: privateScreenResolution(settings, this.display), contentHint });
    const tracks = captured.filter(track => track.kind === Track.Kind.Video);
    captured.filter(track => track.kind !== Track.Kind.Video).forEach(track => track.stop());
    if (!this.current() || tracks.length === 0) { tracks.forEach(track => track.stop()); return false; }
    this.tracks = tracks;
    try {
      for (const track of tracks) {
        await track.mute();
        track.mediaStreamTrack.enabled = false;
        if (!this.current() || hasEnded(track.mediaStreamTrack)) { this.dispose(); return false; }
        await this.room.localParticipant.publishTrack(track, { ...publish, source: Track.Source.ScreenShare, stream: "screenshare" });
        if (!this.current() || hasEnded(track.mediaStreamTrack)) {
          track.mediaStreamTrack.enabled = false; track.stop();
          await this.room.localParticipant.unpublishTrack(track).catch(() => {}); this.dispose(); return false;
        }
        await track.unmute();
        if (!this.current()) { track.mediaStreamTrack.enabled = false; track.stop(); await this.room.localParticipant.unpublishTrack(track).catch(() => {}); this.dispose(); return false; }
      }
      return this.current();
    } catch (error) { this.dispose(); throw error; }
  }
  update(settings: PrivateScreenQuality, publish?: TrackPublishOptions) {
    const revision = ++this.revision;
    this.updates = this.updates.catch(() => {}).then(async () => {
      if (revision !== this.revision || !this.current()) return;
      for (const track of this.tracks) if (track instanceof LocalVideoTrack) {
        const current = () => revision === this.revision && this.current();
        if (publish) track.publishOptions = { ...track.publishOptions, screenShareEncoding: publish.screenShareEncoding };
        await updatePrivateScreenQuality(track.mediaStreamTrack, track.sender, settings, current, this.display, publish?.screenShareEncoding?.maxBitrate);
        for (const [codec, backup] of track.simulcastCodecs) {
          if (!current()) return;
          const backupCodec = publish?.backupCodec;
          const bitrate = typeof backupCodec === "object" && backupCodec.codec === codec ? backupCodec.encoding?.maxBitrate : publish?.screenShareEncoding?.maxBitrate;
          await updatePrivateScreenQuality(backup.mediaStreamTrack, backup.sender, settings, current, this.display, bitrate);
        }
      }
    });
    return this.updates;
  }
  onEnded(callback: () => void) { for (const track of this.tracks) track.mediaStreamTrack.addEventListener("ended", callback, { once: true }); }
  dispose() {
    if (this.disposed) return;
    this.disposed = true; ++this.revision;
    for (const track of this.tracks) {
      track.mediaStreamTrack.enabled = false; track.stop();
      void this.room.localParticipant.unpublishTrack(track).catch(() => {});
    }
    this.tracks = [];
  }
}
