import {ManualVoiceSoundTracker} from "../utils/voiceEventSounds";
import {getAuthSessionSnapshot,subscribeAuthOwnerChanges,subscribeAuthGenerationChanges}from "../api/authSessionEvents";
import {hasGuildCaptureFailure,latchGuildCaptureFailure,clearGuildCaptureFailure,type GuildCaptureCall}from "../stores/microphoneCaptureViewStore";
import {captureAdmissionCurrent,subscribeCaptureAdmission}from "./microphoneAdmission";
import { Track, type LocalAudioTrack, type LocalParticipant } from "livekit-client";
import { useVoiceStore } from "../stores/voiceStore";
import { micPublishFor } from "./micProfile";
import { microphoneSettings, type MicrophoneSettings } from "./microphoneSettings";
import { captureOwnedMicrophone } from "./captureOwnedMicrophone";
import { MicrophoneTrackProcessor } from "./MicrophoneTrackProcessor";

export type CaptureStatus = {phase:"idle"|"capturing"|"ready"|"failed";reason?:"capture_failed"|"source_ended"};
const controllers = new WeakMap<LocalParticipant, LiveMicrophone>();
export function liveMicrophone(participant: LocalParticipant, scope: "guild" | "private" = "guild") {
  let controller = controllers.get(participant);
  if (!controller) { controller = new LiveMicrophone(participant, scope); controllers.set(participant, controller); }
  if (controller.scope !== scope) throw new Error("Microphone controller scope mismatch");
  return controller;
}
export function releaseLiveMicrophone(participant: LocalParticipant, expected?:LiveMicrophone) {
  const controller = controllers.get(participant);
  if(expected&&controller!==expected)return expected.dispose();
  controllers.delete(participant);
  return controller?.dispose();
}

/** The only owner of microphone publication, processing, devices and profile changes. */
class LiveMicrophone {
  private auth = getAuthSessionSnapshot();
  private soundState(){const state=useVoiceStore.getState();return {manualMuted:state.isDeafened?(state.muteBeforeDeafen??true):state.isMuted,deafened:state.isDeafened};}
  private soundTracker = new ManualVoiceSoundTracker(this.soundState(),()=>this.scope==="guild"&&this.current());
  private authCleanup = () => {};
  private matchesCall(){const state=useVoiceStore.getState();return !this.call||(state.currentVoiceChannelId===this.call.channelId&&(state._joinGeneration??0)===this.call.joinGeneration);}
  private current(){return !this.disposed&&this.matchesCall()&&captureAdmissionCurrent(this.participant)&&!!this.auth.ownerId&&JSON.stringify(getAuthSessionSnapshot())===JSON.stringify(this.auth);}
  private call:GuildCaptureCall|null=null;
  canRecover=()=>this.current();
  private enabled = false;
  private failed = false;
  private forceReplace = false;
  private source?: MediaStreamTrack;
  private pendingSource?: MediaStreamTrack;
  private removeSourceListener?: () => void;
  private status: CaptureStatus = {phase:"idle"};
  private listeners = new Set<()=>void>();
  getStatus=()=>this.status;
  subscribe=(callback:()=>void)=>{this.listeners.add(callback);return()=>{this.listeners.delete(callback);};};
  private report(status:CaptureStatus){if(status.phase==="failed"&&this.call)latchGuildCaptureFailure(this.call);this.status=status;this.listeners.forEach(callback=>callback());}
  retry(enabled:boolean){if(!this.current())return Promise.resolve();if(this.call)clearGuildCaptureFailure(this.call);this.failed=false;this.forceReplace=true;this.enabled=enabled;this.report({phase:"idle"});return this.refresh();}
  private sourceEnded(source:MediaStreamTrack){
    if(this.disposed||(this.source!==source&&this.pendingSource!==source))return;
    this.soundTracker.reject();this.failed=true;this.enabled=false;this.generation++;this.candidate?.cancel();
    if(this.processor?.processedTrack)this.processor.processedTrack.enabled=false;
    if(this.candidate?.processedTrack)this.candidate.processedTrack.enabled=false;
    void this.track?.mute().catch(()=>{});this.report({phase:"failed",reason:"source_ended"});
  }
  private disposed = false;
  private generation = 0;
  private serial = Promise.resolve();
  private track?: LocalAudioTrack;
  private processor?: MicrophoneTrackProcessor;
  private candidate?: MicrophoneTrackProcessor;
  private applied?: MicrophoneSettings;
  private participant: LocalParticipant;
  readonly scope: "guild" | "private";
  constructor(participant: LocalParticipant, scope: "guild" | "private") {
    this.participant = participant; this.scope = scope;
    const voice=useVoiceStore.getState();
    if(scope==="guild"&&this.auth.ownerId&&voice.currentVoiceChannelId){this.call={owner:this.auth.ownerId,generation:this.auth.generation,channelId:voice.currentVoiceChannelId,joinGeneration:voice._joinGeneration??0};if(hasGuildCaptureFailure(this.call)){this.failed=true;this.status={phase:"failed",reason:"capture_failed"};}}
    const retire=()=>{if(JSON.stringify(getAuthSessionSnapshot())!==JSON.stringify(this.auth))void this.dispose().catch(()=>{});};
    const owner=subscribeAuthOwnerChanges(retire),generation=subscribeAuthGenerationChanges(retire);const ownership=useVoiceStore.subscribe(()=>{if(!this.matchesCall())void this.dispose().catch(()=>{});});
    const admission=subscribeCaptureAdmission(participant,()=>{if(controllers.get(participant)===this)controllers.delete(participant);void this.dispose().catch(()=>{});});this.authCleanup=()=>{owner();generation();admission();ownership();};
  }
  setEnabled(enabled: boolean) {
    if(this.scope==="guild"){this.soundTracker.observe(this.soundState());if(this.failed)this.soundTracker.reject();}
    this.enabled = enabled;
    if(!enabled&&!this.failed)this.report({phase:"idle"});
    // Close output immediately; initialization or a slow device switch must not
    // delay mute/PTT release. Reopening happens only at the serialized commit.
    if (!enabled && this.track) {
      if (this.processor?.processedTrack) this.processor.processedTrack.enabled = false;
      void this.track.mute().catch(()=>{});
    }
    return this.refresh();
  }
  private shouldEnable() {
    const state = useVoiceStore.getState();
    return this.current() && !this.failed && this.enabled && !state.isDeafened && (this.scope === "private" || (!state.isMuted && !state.isServerMuted));
  }
  refresh() {
    if(this.failed||!this.current())return Promise.resolve();
    const id = ++this.generation;
    this.candidate?.cancel();this.pendingSource?.stop();
    const requested = microphoneSettings(useVoiceStore.getState());
    // Let the graph cancel obsolete model preparation immediately, even while
    // the publication queue is waiting for the previous update to finish.
    const updating = !this.forceReplace && this.processor && this.applied?.inputDevice === requested.inputDevice && this.applied.micProfile === requested.micProfile
      ? this.processor.update(requested) : undefined;
    void updating?.catch(() => {});
    this.serial = this.serial.catch(() => {}).then(async () => {
      if (!this.current() || id !== this.generation) return;
      const settings = microphoneSettings(useVoiceStore.getState());
      const replace = this.forceReplace || !this.track || this.applied?.inputDevice !== settings.inputDevice || this.applied?.micProfile !== settings.micProfile;
      if (replace && this.shouldEnable()) {
        this.report({phase:"capturing"});
        const {track:candidateTrack,source}=await captureOwnedMicrophone(settings,()=>!this.disposed&&id===this.generation&&!this.failed&&this.shouldEnable());
        this.pendingSource=source;
        const ended=()=>this.sourceEnded(source);source.addEventListener("ended",ended);if(source.readyState==="ended")this.sourceEnded(source);
        let processor: MicrophoneTrackProcessor | undefined;
        const candidateCurrent=()=>{if(source.readyState==="ended"){this.sourceEnded(source);return false;}return this.current()&&id===this.generation;};
        try {
          if (!candidateCurrent()) return;
          processor = new MicrophoneTrackProcessor(settings, candidateTrack);
          this.candidate = processor;
          await candidateTrack.setProcessor(processor);
          if (!candidateCurrent()) return;
          await processor.update(settings); // persist actual source constraint after SDK init lock
          if (!candidateCurrent()) return;
          const old = this.track ?? this.participant.getTrackPublication(Track.Source.Microphone)?.track;
          if (old) {
            await this.participant.unpublishTrack(old, true);
            await this.processor?.destroy();
            this.track = undefined;
            this.processor = undefined;
            this.applied = undefined;
          }
          if (!candidateCurrent()) return;
          if (!this.shouldEnable()) {
            if (processor.processedTrack) processor.processedTrack.enabled = false;
            await candidateTrack.mute();
          }
          await this.participant.publishTrack(candidateTrack, { source: Track.Source.Microphone, ...micPublishFor(settings.micProfile) });
          if (!candidateCurrent()) {
            await this.participant.unpublishTrack(candidateTrack, true);
            return;
          }
          this.removeSourceListener?.();
          this.removeSourceListener=()=>source.removeEventListener("ended",ended);
          this.source=source;this.pendingSource=undefined;this.forceReplace=false;
          this.track = candidateTrack;
          this.processor = processor;
          this.applied = settings;
          processor.activate();
        } finally {
          this.candidate = undefined;
          if (this.track !== candidateTrack) { source.removeEventListener("ended",ended);if(this.pendingSource===source)this.pendingSource=undefined;await processor?.destroy(); candidateTrack.stop(); }
        }
      } else if (this.processor && !replace) {
        if (updating) await updating;
        else await this.processor.update(settings);
        this.applied = settings;
      }
      if (this.disposed || id !== this.generation || !this.track) return;
      if (this.shouldEnable()) {
        await this.track.unmute();
        // Recheck after the SDK await; mute may have arrived meanwhile.
        if (this.processor?.processedTrack) this.processor.processedTrack.enabled = this.shouldEnable();
        this.report({phase:this.shouldEnable()?"ready":"idle"});
      } else {
        if (this.processor?.processedTrack) this.processor.processedTrack.enabled = false;
        await this.track.mute();this.report({phase:"idle"});
      }
      if(this.current()&&id===this.generation&&this.scope==="guild")this.soundTracker.commit(this.soundState(),this.shouldEnable());
    }).catch((error:unknown)=>{if(this.disposed||id!==this.generation)return;this.soundTracker.reject();if((error as {name?:string})?.name==="AbortError"){this.report({phase:"idle"});return;}this.failed=true;if(this.processor?.processedTrack)this.processor.processedTrack.enabled=false;void this.track?.mute().catch(()=>{});this.report({phase:"failed",reason:"capture_failed"});throw error;});
    return this.serial;
  }
  async dispose() {
    if(this.disposed)return;
    this.disposed = true;this.authCleanup();
    this.pendingSource?.stop();this.source?.stop();
    this.removeSourceListener?.();this.removeSourceListener=undefined;this.source=undefined;this.pendingSource=undefined;this.report({phase:"idle"});
    this.generation++;
    this.candidate?.cancel();
    this.processor?.cancel();
    if (this.processor?.processedTrack) this.processor.processedTrack.enabled = false;
    await this.serial.catch(() => {});
    if (this.track) await this.participant.unpublishTrack(this.track, true).catch(() => {});
    await this.processor?.destroy();
    this.track?.stop();
  }
}
