import {SystemAudioCaptureSession}from "../../audio/systemAudioCaptureSession";
import {subscribeCaptureAdmission}from "../../audio/microphoneAdmission";
import {isElectron}from "../../utils/constants";
import {SCREEN_SHARE_AUDIO_PUBLISH}from "../../hooks/useScreenSharePublishDefaults";
import { ConnectionState, LocalAudioTrack, LocalVideoTrack, Track, type LocalTrack, type Room, type TrackPublishOptions } from "livekit-client";
import { captureAdmissionCurrent } from "../../audio/microphoneAdmission";
import { privateScreenResolution, type PrivateScreenQuality, type ScreenMetrics } from "../../utils/privateScreenQuality";
import { resolveScreenSharePublishDefaults } from "../../utils/screenShareProfile";
import { LiveKitScreenShareUpdater } from "../../webrtc/livekitScreenShareUpdate";

export type GroupShareAudioStatus="off"|"starting"|"shared"|"not_returned"|"unavailable"|"ended";
const hasEnded = (track: MediaStreamTrack) => track.readyState === "ended";

/** One captured source belongs to one admitted Room, never to a replacement Room. */
export class GroupScreenShareSession {
  private tracks: LocalTrack[] = [];
  private audioTracks=new Set<LocalTrack>();private nativeAudio:SystemAudioCaptureSession|null=null;private audioNotify:(status:GroupShareAudioStatus)=>void;
  private disposed = false;
  private started = false;
  private videoUpdates = new Map<LocalVideoTrack, LiveKitScreenShareUpdater>();
  private room: Room;
  private scope: () => boolean;
  private display?: ScreenMetrics | null;
  constructor(room: Room, scope: () => boolean, display?: ScreenMetrics | null,audioNotify:(status:GroupShareAudioStatus)=>void=()=>{}) { this.room = room; this.scope = scope; this.display = display;this.audioNotify=audioNotify; }
  private current = () => !this.disposed && this.scope() && this.room.state === ConnectionState.Connected
    && this.room.localParticipant.permissions?.canPublish === true && captureAdmissionCurrent(this.room.localParticipant);
  get active() { return this.current() && [...this.videoUpdates.values()].some(updater => updater.active); }
  async start(settings: PrivateScreenQuality, publish: TrackPublishOptions, contentHint: "motion" | "detail",audioRequested=false) {
    if (this.started || !this.current()) return false;
    this.started = true;
    // Browser audio is supplied only by the explicit source-picker choice.
    // Electron uses a separate non-stealing process-exclusive capture lease.
    const captured = await this.room.localParticipant.createScreenTracks({ audio: audioRequested&&!isElectron()?{echoCancellation:false,noiseSuppression:false,autoGainControl:false,channelCount:2}:false, resolution: privateScreenResolution(settings, this.display), contentHint });
    const tracks = captured.filter(track => track.kind === Track.Kind.Video);
    const capturedAudio=captured.filter(track=>track.kind===Track.Kind.Audio&&audioRequested&&!isElectron()).slice(0,1);
    captured.filter(track=>!tracks.includes(track)&&!capturedAudio.includes(track)).forEach(track=>track.stop());
    if (!this.current() || tracks.length === 0) { captured.forEach(track => track.stop()); return false; }
    this.tracks = [...tracks,...capturedAudio];
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
        if (track instanceof LocalVideoTrack) this.videoUpdates.set(track, new LiveKitScreenShareUpdater(
          this.room.localParticipant, track, this.current,
          { settings, publish: { ...publish, source: Track.Source.ScreenShare, stream: "screenshare" }, contentHint, display: this.display },
        ));
      }
      if(audioRequested&&this.current()){
        this.audioNotify("starting");
        if(isElectron()){
          const audio=new SystemAudioCaptureSession({kind:"group",source:crypto.randomUUID(),current:this.current,subscribeCurrent:retire=>subscribeCaptureAdmission(this.room.localParticipant,retire),state:status=>{if(status.phase==="failed"&&this.current()){this.stopAudio();this.audioNotify("ended");}}});this.nativeAudio=audio;
          try{const raw=await audio.start();if(!this.current()){raw.stop();return false;}const track=new LocalAudioTrack(raw,undefined,true);track.source=Track.Source.ScreenShareAudio;await this.publishAudio(track);}catch{if(this.current()){this.stopAudio();this.audioNotify("unavailable");}}
        }else if(capturedAudio.length){for(const track of capturedAudio)await this.publishAudio(track);}
        else this.audioNotify("not_returned");
      }else capturedAudio.forEach(track=>track.stop());
      return this.current();
    } catch (error) { this.dispose(); throw error; }
  }
  private async publishAudio(track:LocalTrack){
    this.audioTracks.add(track);if(!this.tracks.includes(track))this.tracks.push(track);
    const ended=()=>{if(this.current()&&this.audioTracks.has(track)){this.stopAudio();this.audioNotify("ended");}};
    track.mediaStreamTrack.addEventListener("ended",ended,{once:true});
    try{
      await track.mute();track.mediaStreamTrack.enabled=false;
      if(!this.audioTracks.has(track))return;if(!this.current()){this.stopAudio();return;}if(hasEnded(track.mediaStreamTrack)){this.stopAudio();this.audioNotify("ended");return;}
      await this.room.localParticipant.publishTrack(track,{...SCREEN_SHARE_AUDIO_PUBLISH,source:Track.Source.ScreenShareAudio,stream:"screenshare"});
      if(!this.audioTracks.has(track))return;if(!this.current()){this.stopAudio();return;}if(hasEnded(track.mediaStreamTrack)){this.stopAudio();this.audioNotify("ended");return;}
      await track.unmute();
      if(!this.audioTracks.has(track))return;if(!this.current()){this.stopAudio();return;}if(hasEnded(track.mediaStreamTrack)){this.stopAudio();this.audioNotify("ended");return;}
      this.audioNotify("shared");
    }catch{if(this.current()){this.stopAudio();this.audioNotify("unavailable");}}
  }
  ownsAudio(track:LocalTrack|undefined){return !!track&&this.audioTracks.has(track);}
  stopAudio(){const tracks=[...this.audioTracks];this.audioTracks.clear();this.tracks=this.tracks.filter(track=>!tracks.includes(track));this.nativeAudio?.stop();this.nativeAudio=null;for(const track of tracks){track.mediaStreamTrack.enabled=false;track.stop();void this.room.localParticipant.unpublishTrack(track).catch(()=>{});}}
  async update(settings: PrivateScreenQuality, publish?: TrackPublishOptions) {
    if (!this.current()) return;
    const profile = resolveScreenSharePublishDefaults(settings, this.display);
    for (const updater of this.videoUpdates.values()) {
      await updater.update({ settings, publish: publish ?? profile.screenSharePublish,
        contentHint: profile.screenShareCapture.contentHint, display: this.display });
    }
  }
  onEnded(callback: () => void) { for (const track of this.tracks.filter(track=>track.kind===Track.Kind.Video)) track.mediaStreamTrack.addEventListener("ended", callback, { once: true }); }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;this.stopAudio();
    const ownedVideos = new Set(this.videoUpdates.keys());
    for (const updater of this.videoUpdates.values()) updater.dispose();
    this.videoUpdates.clear();
    for (const track of this.tracks) {
      if (ownedVideos.has(track as LocalVideoTrack)) continue;
      track.mediaStreamTrack.enabled = false; track.stop();
      void this.room.localParticipant.unpublishTrack(track).catch(() => {});
    }
    this.tracks = [];
  }
}
