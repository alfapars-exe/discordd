import { LocalAudioTrack as LKLocalAudioTrack, Track, type LocalParticipant, type LocalTrackPublication } from "livekit-client";
import type { ScreenShareQuality, ScreenShareFps } from "../stores/voiceStore";
import type { DisplayInfo } from "../hooks/useDisplayInfo";
import { resolveScreenSharePublishDefaults, type ScreenShareProfileSettings, type ScreenSharePublishDefaults } from "../utils/screenShareProfile";
import { privateScreenResolution } from "../utils/privateScreenQuality";

type DesktopBranch = "electron-audio" | "browser";
type DesktopOperations = {
  localParticipant: LocalParticipant;
  getSettings: () => ScreenShareProfileSettings & { screenShareAudio: boolean };
  getDisplay: () => DisplayInfo | null;
  isMobileBrowser: () => boolean;
  canBrowserScreenShare: () => boolean;
  ownPublishedShare: (q: ScreenShareQuality, fps: ScreenShareFps, options: ScreenSharePublishDefaults, cancelled: () => boolean) => boolean;
  startAudio: (isCurrent: () => boolean) => Promise<MediaStreamTrack | null>;
  setAudioPublication: (publication: LocalTrackPublication) => void;
  releaseOwnedShare: () => LocalTrackPublication | undefined | null;
  stopAudio: () => void;
  unsupported: () => void;
  started: () => void;
  stopped: () => void;
  logVideo: (branch: DesktopBranch) => void;
  logAudio: (branch: DesktopBranch) => void;
  log: (level: "info" | "warn", message: string, details: Record<string, string | number | boolean | null | undefined>) => unknown;
};

function resolutionFor(quality: string, fps: number, display: DisplayInfo | null) {
  return privateScreenResolution({ screenShareQuality: quality, screenShareFps: fps }, display);
}

export function createDesktopScreenShareController(operations: DesktopOperations) {
  const { localParticipant } = operations;
  const retireCancelledStart = async (publication: LocalTrackPublication | undefined, streamName: string) => {
    const publications = new Set([publication, ...localParticipant.trackPublications.values()]);
    const tracks = [...publications].flatMap(pub => pub?.track && pub.options?.stream === streamName ? [pub.track] : []);
    for (const track of tracks) {
      track.mediaStreamTrack.enabled = false;
      track.stop();
    }
    await Promise.all(tracks.map(track => localParticipant.unpublishTrack(track).catch(() => {})));
  };
  async function startElectron(ssq: ScreenShareQuality, ssFps: ScreenShareFps,
    streamName: string, attemptStart: number, shouldCancel: () => boolean): Promise<void> {
    const branch = "electron-audio";
    const opts = resolveScreenSharePublishDefaults({ ...operations.getSettings(), screenShareQuality: ssq, screenShareFps: ssFps }, operations.getDisplay());
    // captureOptions (2nd arg) — getDisplayMedia hints; we suppress
    // audio in this branch because the native helper publishes a
    // separate audio track later.
    // The updater retains this capture for subsequent profile changes.
    const publication = await localParticipant.setScreenShareEnabled(true, {
      audio: false,
      resolution: resolutionFor(ssq, ssFps, operations.getDisplay()),
      contentHint: opts.screenShareCapture.contentHint,
      // Name the video's MediaStream so the separately-published WASAPI
      // audio track (below) can join the same stream → A/V sync grouping.
    }, { ...opts.screenSharePublish, stream: streamName });

    if (shouldCancel()) { await retireCancelledStart(publication, streamName); return; }

    if (!operations.ownPublishedShare(ssq, ssFps, opts, shouldCancel)) throw new DOMException("Screen source ended before publication", "AbortError");

    // Video is published — tell the server now so viewers see is_streaming=true
    // even if the audio capture below fails (which is logged as
    // screen_share_success_no_audio).
    operations.started();
    operations.logVideo(branch);

    // Read the choice after the picker closes: both enabling and disabling
    // its audio checkbox must apply to this capture, without a second picker.
    if (!operations.getSettings().screenShareAudio) {
      void operations.log("info", "screen_share_success", { branch, audio: false, durationMs: Date.now() - attemptStart });
      return;
    }
    const audioTrack = await operations.startAudio(()=>!shouldCancel());
    if (shouldCancel() || !audioTrack) {
      // Video already published; audio track failed (Mac/Linux no
      // native helper, WASAPI denied, etc.). Log the partial state so
      // we can tell crash-with-audio from crash-without.
      operations.log("warn", "screen_share_success_no_audio", {
        branch,
        durationMs: Date.now() - attemptStart,
        reason: shouldCancel() ? "cancelled" : "no_audio_track",
      });
      return;
    }

    const lkTrack = new LKLocalAudioTrack(audioTrack, undefined, true);
    lkTrack.source=Track.Source.ScreenShareAudio;
    await lkTrack.mute();
    if(shouldCancel()||audioTrack.readyState!=="live"){lkTrack.stop();return;}
    const pub = await localParticipant.publishTrack(lkTrack, {
      source: Track.Source.ScreenShareAudio,
      // Media profile: forced stereo + DTX-off + dedicated bitrate (see
      // useScreenSharePublishDefaults). Critical here because the track comes
      // from a WebAudio MediaStreamDestination whose getSettings() often omits
      // channelCount — without forceStereo the SDK publishes mono + DTX-on,
      // which is the "yayın sesi kalitesiz" bug.
      ...opts.screenShareAudioPublish,
      // Same stream name as the video above → one MediaStream for A/V sync.
      stream: streamName,
    });
    if(shouldCancel()||audioTrack.readyState!=="live"){lkTrack.stop();await localParticipant.unpublishTrack(lkTrack).catch(()=>{});return;}
    await lkTrack.unmute();
    if(shouldCancel()||audioTrack.readyState!=="live"){lkTrack.stop();await localParticipant.unpublishTrack(lkTrack).catch(()=>{});return;}
    operations.setAudioPublication(pub);
    operations.logAudio(branch);
    operations.log("info", "screen_share_success", {
      branch,
      durationMs: Date.now() - attemptStart,
    });
  }
  async function startBrowser(ssq: ScreenShareQuality, ssFps: ScreenShareFps,
    streamName: string, attemptStart: number, initialAudio: boolean, shouldCancel: () => boolean): Promise<void> {
    const branch = "browser";
    // Browser path — LiveKit calls navigator.mediaDevices.getDisplayMedia.
    // Cap-check first so iOS Safari (no getDisplayMedia) surfaces a
    // toast instead of failing silently when the user taps the button.
    if (!operations.canBrowserScreenShare()) {
      operations.unsupported();
      operations.stopped();
      return;
    }

    // Mobile browsers (Android Chrome on phone): clamp to 720p/30fps
    // regardless of the user's saved quality preference. A 1440p
    // request on a 360-px-wide phone screen wastes upstream bandwidth
    // and trips OOM on weak GPUs.
    const effQ = operations.isMobileBrowser() ? "720p" : ssq;
    const effFps = operations.isMobileBrowser() ? 30 : ssFps;
    const opts = resolveScreenSharePublishDefaults({ ...operations.getSettings(), screenShareQuality: effQ, screenShareFps: effFps }, operations.getDisplay());
    const publication = await localParticipant.setScreenShareEnabled(true, {
      // Clean STEREO capture for media audio: voice DSP (echo cancellation /
      // noise suppression / AGC) would mangle music/game audio, so disable it
      // and request two channels. A unique stream groups this capture's
      // audio/video and lets a cancelled picker retire only its own source.
      audio: initialAudio
        ? {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            channelCount: 2,
          }
        : false,
      resolution: resolutionFor(effQ, effFps, operations.getDisplay()),
      contentHint: opts.screenShareCapture.contentHint,
      // Audio publish profile (stereo + DTX-off) merged into the single
      // publishOptions; the video track ignores audio-only fields and vice-versa.
    }, { ...opts.screenSharePublish, ...opts.screenShareAudioPublish, stream: streamName });
    if (shouldCancel()) { await retireCancelledStart(publication, streamName); return; }
    if (!operations.ownPublishedShare(effQ, effFps, opts, shouldCancel)) throw new DOMException("Screen source ended before publication", "AbortError");
    operations.started();
    operations.logVideo(branch);
    if (initialAudio) operations.logAudio(branch);
    operations.log("info", "screen_share_success", {
      branch,
      durationMs: Date.now() - attemptStart,
      effectiveQuality: effQ,
      effectiveFps: effFps,
    });
  }
  return {
    async start(branch: DesktopBranch, ssq: ScreenShareQuality, ssFps: ScreenShareFps,
      streamName: string, attemptStart: number, initialAudio: boolean, shouldCancel: () => boolean): Promise<void> {
      if (branch === "electron-audio") await startElectron(ssq, ssFps, streamName, attemptStart, shouldCancel);
      else await startBrowser(ssq, ssFps, streamName, attemptStart, initialAudio, shouldCancel);
    },
    async stop(): Promise<void> {
      const audio = operations.releaseOwnedShare();
      operations.stopAudio();
      if (audio?.track) await localParticipant.unpublishTrack(audio.track);
      await localParticipant.setScreenShareEnabled(false);
    },
  };
}
