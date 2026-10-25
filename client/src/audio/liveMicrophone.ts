import { createLocalAudioTrack, Track, type LocalAudioTrack, type LocalParticipant } from "livekit-client";
import { useVoiceStore } from "../stores/voiceStore";
import { micPublishFor } from "./micProfile";
import { microphoneSettings, desiredEngine, type MicrophoneSettings } from "./microphoneSettings";
import { MicrophoneTrackProcessor } from "./MicrophoneTrackProcessor";

const controllers = new WeakMap<LocalParticipant, LiveMicrophone>();
export function liveMicrophone(participant: LocalParticipant) {
  let controller = controllers.get(participant);
  if (!controller) { controller = new LiveMicrophone(participant); controllers.set(participant, controller); }
  return controller;
}
export function releaseLiveMicrophone(participant: LocalParticipant) {
  const controller = controllers.get(participant);
  controllers.delete(participant);
  return controller?.dispose();
}

/** The only owner of microphone publication, processing, devices and profile changes. */
class LiveMicrophone {
  private enabled = false;
  private disposed = false;
  private generation = 0;
  private serial = Promise.resolve();
  private track?: LocalAudioTrack;
  private processor?: MicrophoneTrackProcessor;
  private candidate?: MicrophoneTrackProcessor;
  private applied?: MicrophoneSettings;
  private participant: LocalParticipant;
  constructor(participant: LocalParticipant) { this.participant = participant; }
  setEnabled(enabled: boolean) {
    this.enabled = enabled;
    // Close output immediately; initialization or a slow device switch must not
    // delay mute/PTT release. Reopening happens only at the serialized commit.
    if (!enabled && this.track) {
      if (this.processor?.processedTrack) this.processor.processedTrack.enabled = false;
      void this.track.mute();
    }
    return this.refresh();
  }
  private shouldEnable() {
    const state = useVoiceStore.getState();
    return this.enabled && !state.isMuted && !state.isServerMuted;
  }
  refresh() {
    const id = ++this.generation;
    this.candidate?.cancel();
    const requested = microphoneSettings(useVoiceStore.getState());
    // Let the graph cancel obsolete model preparation immediately, even while
    // the publication queue is waiting for the previous update to finish.
    const updating = this.processor && this.applied?.inputDevice === requested.inputDevice && this.applied.micProfile === requested.micProfile
      ? this.processor.update(requested) : undefined;
    void updating?.catch(() => {});
    this.serial = this.serial.catch(() => {}).then(async () => {
      if (this.disposed || id !== this.generation) return;
      const settings = microphoneSettings(useVoiceStore.getState());
      const replace = !this.track || this.applied?.inputDevice !== settings.inputDevice || this.applied?.micProfile !== settings.micProfile;
      if (replace && (this.track || this.shouldEnable())) {
        const music = settings.micProfile === "muzik";
        const candidateTrack = await createLocalAudioTrack({
          deviceId: settings.inputDevice || undefined, echoCancellation: !music,
          autoGainControl: !music, noiseSuppression: desiredEngine(settings) === "webrtc",
          channelCount: music ? 2 : 1,
        });
        let processor: MicrophoneTrackProcessor | undefined;
        try {
          if (this.disposed || id !== this.generation) return;
          processor = new MicrophoneTrackProcessor(settings, candidateTrack);
          this.candidate = processor;
          await candidateTrack.setProcessor(processor);
          if (this.disposed || id !== this.generation) return;
          await processor.update(settings); // persist actual source constraint after SDK init lock
          if (this.disposed || id !== this.generation) return;
          const old = this.track ?? this.participant.getTrackPublication(Track.Source.Microphone)?.track;
          if (old) {
            await this.participant.unpublishTrack(old, true);
            await this.processor?.destroy();
            this.track = undefined;
            this.processor = undefined;
            this.applied = undefined;
          }
          if (this.disposed || id !== this.generation) return;
          if (!this.shouldEnable()) {
            if (processor.processedTrack) processor.processedTrack.enabled = false;
            await candidateTrack.mute();
          }
          await this.participant.publishTrack(candidateTrack, { source: Track.Source.Microphone, ...micPublishFor(settings.micProfile) });
          if (this.disposed || id !== this.generation) {
            await this.participant.unpublishTrack(candidateTrack, true);
            return;
          }
          this.track = candidateTrack;
          this.processor = processor;
          this.applied = settings;
          processor.activate();
        } finally {
          this.candidate = undefined;
          if (this.track !== candidateTrack) { await processor?.destroy(); candidateTrack.stop(); }
        }
      } else if (this.processor) {
        if (updating) await updating;
        else await this.processor.update(settings);
        this.applied = settings;
      }
      if (this.disposed || id !== this.generation || !this.track) return;
      if (this.shouldEnable()) {
        await this.track.unmute();
        // Recheck after the SDK await; mute may have arrived meanwhile.
        if (this.processor?.processedTrack) this.processor.processedTrack.enabled = this.shouldEnable();
      } else {
        if (this.processor?.processedTrack) this.processor.processedTrack.enabled = false;
        await this.track.mute();
      }
    });
    return this.serial;
  }
  async dispose() {
    this.disposed = true;
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
