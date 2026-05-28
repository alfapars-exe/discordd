/**
 * useScreenShareToggle — drive LiveKit screen share from voiceStore.isStreaming
 * and reflect external stops back into the store.
 *
 * Four effects, all part of the same lifecycle:
 *
 *   1. Forward sync (`toggleScreenShare`): when `isStreaming` flips, start or
 *      stop sharing. Three execution paths:
 *      - Capacitor (iOS/Android): native plugin via a separate LiveKit
 *        connection (ReplayKit on iOS, MediaProjection on Android). Token is
 *        fetched from the server first.
 *      - Electron + audio: video via getDisplayMedia, audio via the native
 *        `audio-capture.exe` WASAPI helper that excludes our own process tree
 *        (this is what prevents screen-share echo). The captured audio track
 *        is then re-published as Track.Source.ScreenShareAudio.
 *      - Browser / Electron-no-audio: standard getDisplayMedia with optional
 *        audio.
 *      If anything throws while starting, we roll the store back to
 *      isStreaming=false AND notify the server via _wsSend so other clients
 *      don't see a phantom share.
 *
 *   2. Capacitor external-stop listener: ReplayKit / MediaProjection allow
 *      the user to stop sharing from the OS UI. We listen for that event and
 *      sync the store + server.
 *
 *   3. LocalTrackUnpublished listener: the desktop "Stop sharing" dialog
 *      (and SFU drops, reconnects) tear the screen-share track down outside
 *      our control. By the time this event fires, the track is already gone,
 *      so it's safe to send is_streaming=false to the server — no phantom
 *      share window for other clients. Suppressed during programmatic
 *      restarts via `isRestartingRef`.
 *
 *   4. Restart watcher: when the user changes screenShareQuality or
 *      screenShareFps mid-stream, debounce 350 ms then run stop→start with
 *      the new values. The browser branch will re-prompt the OS source
 *      picker; Electron + Capacitor branches restart silently. A
 *      generation counter cancels in-flight restarts when a newer change
 *      lands during the debounce or stop phase.
 *
 * The hook also calls `useSystemAudioCapture()` and holds it in a latest-ref
 * — that consumer was inline in VoiceStateManager.tsx.
 */

import { useEffect, useLayoutEffect, useRef } from "react";
import {
  RoomEvent,
  Track,
  LocalAudioTrack as LKLocalAudioTrack,
  type LocalParticipant,
  type LocalTrackPublication,
  type Room,
} from "livekit-client";

import {
  useVoiceStore,
  type ScreenShareQuality,
  type ScreenShareFps,
} from "../stores/voiceStore";
import { useServerStore } from "../stores/serverStore";
import { useToastStore } from "../stores/toastStore";
import { useSystemAudioCapture } from "./useSystemAudioCapture";
import { useDisplayInfo, type DisplayInfo } from "./useDisplayInfo";
import { useScreenSharePublishDefaults } from "./useScreenSharePublishDefaults";
import {
  isElectron,
  isCapacitor,
  isMobileBrowser,
  canBrowserScreenShare,
} from "../utils/constants";
import {
  startNativeScreenShare,
  stopNativeScreenShare,
  onNativeScreenShareStopped,
} from "../utils/nativePlugins";
import { getScreenShareToken } from "../api/voice";
import { logToServer } from "../api/clientLog";
import i18n from "../i18n";

type ScreenShareResolution = {
  width: number;
  height: number;
  frameRate: number;
};

/**
 * Map (quality, fps) to a getDisplayMedia constraint set. The browser/Electron
 * side honors this as a hint — the browser may downsample if the source can't
 * deliver the requested rate.
 *
 * `display` is the monitor metrics from useDisplayInfo. Needed to resolve
 * the "native"/-1 sentinels into concrete numbers — see Track P. Falls back
 * to 1080p/60 when display is null (hook still loading or browser without
 * IPC) so the function never returns a 0-pixel resolution.
 */
function resolutionFor(
  quality: string,
  fps: number,
  display: DisplayInfo | null,
): ScreenShareResolution {
  const resolvedFps =
    fps === -1 ? (display?.refreshRate && display.refreshRate > 0 ? display.refreshRate : 60) : fps;

  if (quality === "native" && display && display.width > 0) {
    return { width: display.width, height: display.height, frameRate: resolvedFps };
  }
  if (quality === "1440p") return { width: 2560, height: 1440, frameRate: resolvedFps };
  if (quality === "1080p") return { width: 1920, height: 1080, frameRate: resolvedFps };
  return { width: 1280, height: 720, frameRate: resolvedFps };
}

function notifyServerStopped() {
  const { _wsSend } = useVoiceStore.getState();
  useVoiceStore.getState().setStreaming(false);
  _wsSend?.("voice_state_update_request", { is_streaming: false });
}

/**
 * Which start/stop branch a given screen-share lifecycle should take.
 * Pulled out of the toggle effect so the restart watcher can recompute
 * the branch at restart time without duplicating the if/else cascade.
 */
type ShareBranch = "capacitor" | "electron-audio" | "browser";

function computeShareBranch(screenShareAudio: boolean): ShareBranch {
  if (isCapacitor()) return "capacitor";
  if (isElectron() && screenShareAudio) return "electron-audio";
  return "browser";
}

export function useScreenShareToggle(
  room: Room,
  localParticipant: LocalParticipant,
  initialSyncDoneRef: React.RefObject<boolean>,
): void {
  const isStreaming = useVoiceStore((s) => s.isStreaming);
  const screenShareAudio = useVoiceStore((s) => s.screenShareAudio);
  // Subscribed so Effect 4 re-runs when the user picks a new value in the
  // ScreenShareQualityPopup. Effect 1 doesn't depend on these — they're
  // read fresh from getState() at start time.
  const screenShareQuality = useVoiceStore((s) => s.screenShareQuality);
  const screenShareFps = useVoiceStore((s) => s.screenShareFps);

  // Monitor metrics — used to resolve the "native"/-1 sentinels in
  // (quality, fps) into concrete numbers at publish time. Held in a ref
  // so the toggle effect picks up the latest value without re-subscribing.
  const display = useDisplayInfo();
  const displayRef = useRef(display);
  useLayoutEffect(() => {
    displayRef.current = display;
  });

  // Per-publish encoder + capture options. Held in a ref so the toggle
  // effect captures the latest value at publish time without re-running
  // every time the user opens settings. Was previously applied via the
  // room-level publishDefaults (one-shot at room creation), which made
  // mid-session quality / mode changes a no-op until the user reconnected.
  const publishOpts = useScreenSharePublishDefaults();
  const publishOptsRef = useRef(publishOpts);
  useLayoutEffect(() => {
    publishOptsRef.current = publishOpts;
  });

  // Native Electron audio capture — excludes our own process tree to prevent
  // screen-share echo. Held in a latest-ref so the toggle effect doesn't
  // re-register on every mount of the underlying capture hook.
  const systemAudioCapture = useSystemAudioCapture();
  const systemAudioCaptureRef = useRef(systemAudioCapture);
  useLayoutEffect(() => {
    systemAudioCaptureRef.current = systemAudioCapture;
  });

  // The publication of the WASAPI-captured audio track (Electron path only).
  const customAudioPubRef = useRef<LocalTrackPublication | null>(null);

  // Restart machinery — see Effect 4 and `runRestart`.
  //   prevSettingsRef: last (q, fps) we observed. null on first mount so we
  //     can distinguish "initial hydration from localStorage" from a real
  //     user change.
  //   restartGenRef: monotonic counter bumped on every quality/fps change.
  //     Every async branch inside `runRestart` bails out if its captured gen
  //     is stale, so a newer change supersedes an in-flight restart cleanly.
  //   restartTimerRef: pending debounce timer id, or null.
  //   isRestartingRef: true while a programmatic stop+start cycle is in
  //     flight. Read by Effect 3 to suppress the LocalTrackUnpublished →
  //     notifyServerStopped path during our own stop call.
  const prevSettingsRef = useRef<{
    q: ScreenShareQuality;
    fps: ScreenShareFps;
  } | null>(null);
  const restartGenRef = useRef(0);
  const restartTimerRef = useRef<number | null>(null);
  const isRestartingRef = useRef(false);

  // ──────────────────────────────────────────────────────────────────────
  // Shared start/stop helpers used by Effect 1 AND `runRestart`.
  //
  // Defined as inner functions so they close over the latest-refs above.
  // They throw on failure; the caller is responsible for catching and
  // surfacing user feedback via handleStartFailure().
  // ──────────────────────────────────────────────────────────────────────

  async function startShareInternal(
    branch: ShareBranch,
    ssq: ScreenShareQuality,
    ssFps: ScreenShareFps,
    shouldCancel: () => boolean,
  ): Promise<void> {
    if (shouldCancel()) return;

    // Diagnostic — record the publish attempt with every input that
    // could influence the encode path. Captured BEFORE the branch so a
    // crash mid-branch still has the attempt row to correlate against.
    const ss = useVoiceStore.getState();
    const attemptStart = Date.now();
    logToServer("info", "screen_share_attempt", {
      branch,
      quality: ssq,
      fps: ssFps,
      audio: ss.screenShareAudio,
      lowLatency: ss.screenShareLowLatency,
      codec: ss.screenShareLowLatency ? "h264" : "vp9",
      showCursor: ss.screenShareShowCursor,
      displayWidth: displayRef.current?.width ?? 0,
      displayHeight: displayRef.current?.height ?? 0,
      refreshRate: displayRef.current?.refreshRate ?? 0,
      monitorCount: displayRef.current?.monitorCount ?? 0,
    });

    if (branch === "capacitor") {
      const serverId = useServerStore.getState().activeServerId;
      const channelId = useVoiceStore.getState().currentVoiceChannelId;
      if (!serverId || !channelId) return;

      const response = await getScreenShareToken(serverId, channelId);
      if (shouldCancel() || !response.success || !response.data) {
        console.error(
          "[useScreenShareToggle] Failed to get screen share token:",
          response.error,
        );
        logToServer("warn", "screen_share_token_failed", {
          branch,
          error: response.error ?? "unknown",
        });
        return;
      }

      await startNativeScreenShare(response.data.url, response.data.token);
      logToServer("info", "screen_share_success", {
        branch,
        durationMs: Date.now() - attemptStart,
      });
    } else if (branch === "electron-audio") {
      const opts = publishOptsRef.current;
      // captureOptions (2nd arg) — getDisplayMedia hints; we suppress
      // audio in this branch because the native helper publishes a
      // separate audio track later.
      // publishOptions (3rd arg) — encoder + simulcast + codec are
      // taken from useScreenSharePublishDefaults so quality / FPS /
      // mode changes apply on the NEXT screen-share start without a
      // full room reconnect.
      await localParticipant.setScreenShareEnabled(true, {
        audio: false,
        resolution: resolutionFor(ssq, ssFps, displayRef.current),
        contentHint: opts.screenShareCapture.contentHint,
      }, opts.screenSharePublish);

      if (shouldCancel()) return;

      const audioTrack = await systemAudioCaptureRef.current.start();
      if (shouldCancel() || !audioTrack) {
        // Video already published; audio track failed (Mac/Linux no
        // native helper, WASAPI denied, etc.). Log the partial state so
        // we can tell crash-with-audio from crash-without.
        logToServer("warn", "screen_share_success_no_audio", {
          branch,
          durationMs: Date.now() - attemptStart,
          reason: shouldCancel() ? "cancelled" : "no_audio_track",
        });
        return;
      }

      const lkTrack = new LKLocalAudioTrack(audioTrack, undefined, false);
      const pub = await localParticipant.publishTrack(lkTrack, {
        source: Track.Source.ScreenShareAudio,
      });
      customAudioPubRef.current = pub;
      logToServer("info", "screen_share_success", {
        branch,
        durationMs: Date.now() - attemptStart,
      });
    } else {
      // Browser path — LiveKit calls navigator.mediaDevices.getDisplayMedia.
      // Cap-check first so iOS Safari (no getDisplayMedia) surfaces a
      // toast instead of failing silently when the user taps the button.
      if (!canBrowserScreenShare()) {
        useToastStore.getState().addToast(
          "error",
          i18n.t("screenShareNotSupported", { ns: "voice" }),
          6000,
        );
        notifyServerStopped();
        return;
      }

      // Mobile browsers (Android Chrome on phone): clamp to 720p/30fps
      // regardless of the user's saved quality preference. A 1440p
      // request on a 360-px-wide phone screen wastes upstream bandwidth
      // and trips OOM on weak GPUs.
      const effQ = isMobileBrowser() ? "720p" : ssq;
      const effFps = isMobileBrowser() ? 30 : ssFps;
      const opts = publishOptsRef.current;
      await localParticipant.setScreenShareEnabled(true, {
        audio: ss.screenShareAudio,
        resolution: resolutionFor(effQ, effFps, displayRef.current),
        contentHint: opts.screenShareCapture.contentHint,
      }, opts.screenSharePublish);
      logToServer("info", "screen_share_success", {
        branch,
        durationMs: Date.now() - attemptStart,
        effectiveQuality: effQ,
        effectiveFps: effFps,
      });
    }
  }

  async function stopShareInternal(branch: ShareBranch): Promise<void> {
    if (branch === "capacitor") {
      await stopNativeScreenShare();
    } else {
      if (customAudioPubRef.current) {
        await localParticipant.unpublishTrack(
          customAudioPubRef.current.track!,
        );
        customAudioPubRef.current = null;
      }
      systemAudioCaptureRef.current.stop();
      await localParticipant.setScreenShareEnabled(false);
    }
  }

  function handleStartFailure(err: unknown): void {
    // NotAllowedError = user cancelled the browser permission prompt.
    // That's a normal "I changed my mind" path — no toast, just
    // rollback the streaming flag silently.
    const isCancellation =
      err instanceof Error &&
      (err.name === "NotAllowedError" || err.name === "AbortError");
    if (!isCancellation) {
      useToastStore.getState().addToast(
        "error",
        i18n.t("screenShareFailed", { ns: "voice" }),
        6000,
      );
    }
    // Failure log — pair against the attempt log via userId + timestamp
    // on the admin side. Cancellations are info-level since they're
    // not a bug; everything else is warn so it stands out.
    const errName = err instanceof Error ? err.name : typeof err;
    const errMsg = err instanceof Error ? err.message : String(err);
    const errStack =
      err instanceof Error && err.stack ? err.stack.slice(0, 1024) : "";
    logToServer(isCancellation ? "info" : "warn", "screen_share_failure", {
      isCancellation,
      errorName: errName,
      errorMessage: errMsg,
      errorStack: errStack,
    });
    notifyServerStopped();
  }

  // Effect 1: forward sync — drive LiveKit from store.isStreaming.
  useEffect(() => {
    if (!initialSyncDoneRef.current) return;

    let cancelled = false;

    async function toggleScreenShare() {
      if (cancelled) return;

      const branch = computeShareBranch(screenShareAudio);

      if (isStreaming) {
        const { screenShareQuality: ssq, screenShareFps: ssFps } =
          useVoiceStore.getState();
        await startShareInternal(branch, ssq, ssFps, () => cancelled);
      } else {
        await stopShareInternal(branch);
      }
    }

    toggleScreenShare().catch((err: unknown) => {
      if (!cancelled) {
        console.error("[useScreenShareToggle] Failed to toggle screen share:", err);
        if (isStreaming) {
          handleStartFailure(err);
        }
      }
    });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isStreaming, screenShareAudio, localParticipant, initialSyncDoneRef]);

  // Effect 2: Capacitor — listen for native-side external stops.
  // Track is already torn down by the native side at this point, so the
  // server notification is safe (no phantom-share window).
  useEffect(() => {
    if (!isCapacitor()) return;

    let removeListener: (() => void) | null = null;

    onNativeScreenShareStopped(() => {
      const { isStreaming: currentlyStreaming } = useVoiceStore.getState();
      if (currentlyStreaming) {
        notifyServerStopped();
      }
    }).then((cleanup) => {
      removeListener = cleanup;
    });

    return () => {
      removeListener?.();
    };
  }, []);

  // Effect 3: detect external stops on desktop/browser.
  // The OS-level "Stop sharing" dialog, SFU drops, reconnects — all surface
  // here as LocalTrackUnpublished. Track is already gone by the time the
  // event fires, so notifying the server is safe.
  //
  // Suppressed during programmatic restarts: when `runRestart` calls
  // setScreenShareEnabled(false) the SDK fires LocalTrackUnpublished, which
  // would otherwise race the start phase and flip `isStreaming` to false.
  useEffect(() => {
    function handleLocalTrackUnpublished(pub: LocalTrackPublication) {
      if (pub.source !== Track.Source.ScreenShare) return;
      if (isRestartingRef.current) return;
      const { isStreaming: streaming } = useVoiceStore.getState();
      if (streaming) {
        notifyServerStopped();
      }
    }

    room.on(RoomEvent.LocalTrackUnpublished, handleLocalTrackUnpublished);
    return () => {
      room.off(RoomEvent.LocalTrackUnpublished, handleLocalTrackUnpublished);
    };
  }, [room]);

  async function runRestart(
    myGen: number,
    oldVals: { q: ScreenShareQuality; fps: ScreenShareFps },
    newVals: { q: ScreenShareQuality; fps: ScreenShareFps },
  ): Promise<void> {
    if (myGen !== restartGenRef.current) return;

    const { isStreaming: streaming, screenShareAudio: ssa } =
      useVoiceStore.getState();
    if (!streaming) return;

    const branch = computeShareBranch(ssa);
    const shouldCancel = () => myGen !== restartGenRef.current;

    isRestartingRef.current = true;
    try {
      logToServer("info", "screen_share_restart", {
        trigger: oldVals.q !== newVals.q ? "quality" : "fps",
        oldQuality: oldVals.q,
        newQuality: newVals.q,
        oldFps: oldVals.fps,
        newFps: newVals.fps,
        branch,
      });

      await stopShareInternal(branch);
      if (shouldCancel()) return;

      await startShareInternal(branch, newVals.q, newVals.fps, shouldCancel);
    } catch (err: unknown) {
      if (shouldCancel()) return;
      console.error("[useScreenShareToggle] Restart failed:", err);
      handleStartFailure(err);
    } finally {
      // Only clear suppression if we're still the current restart — a newer
      // restart may have already taken over the flag.
      if (myGen === restartGenRef.current) {
        isRestartingRef.current = false;
      }
    }
  }

  // Effect 4: restart watcher.
  //
  // Fires when screenShareQuality or screenShareFps changes. Debounces 350 ms
  // so a 720p→1080p→1440p click run results in ONE restart with the final
  // values rather than three nested restarts. Skips:
  //   - first run (initial hydration from localStorage)
  //   - changes while the user isn't currently sharing
  //   - changes that match the previous value (defensive)
  //
  // Cancellation: `restartGenRef` is bumped on every change. The async body
  // re-checks the generation after every await and bails if a newer change
  // has landed — so rapid clicks don't pile up restart bodies.
  useEffect(() => {
    if (!initialSyncDoneRef.current) return;

    // First mount: record the current (q, fps) without triggering a restart.
    // This skips the "load from localStorage" hydration path.
    if (prevSettingsRef.current === null) {
      prevSettingsRef.current = { q: screenShareQuality, fps: screenShareFps };
      return;
    }

    const prev = prevSettingsRef.current;
    if (prev.q === screenShareQuality && prev.fps === screenShareFps) return;

    const next: { q: ScreenShareQuality; fps: ScreenShareFps } = {
      q: screenShareQuality,
      fps: screenShareFps,
    };
    prevSettingsRef.current = next;

    // Only restart if the user is actively sharing right now.
    if (!useVoiceStore.getState().isStreaming) return;

    // Bump generation so any in-flight restart from the previous click bails
    // at its next await checkpoint.
    const myGen = ++restartGenRef.current;

    if (restartTimerRef.current !== null) {
      window.clearTimeout(restartTimerRef.current);
      restartTimerRef.current = null;
    }

    restartTimerRef.current = window.setTimeout(() => {
      restartTimerRef.current = null;
      void runRestart(myGen, prev, next);
    }, 350);

    return () => {
      if (restartTimerRef.current !== null) {
        window.clearTimeout(restartTimerRef.current);
        restartTimerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screenShareQuality, screenShareFps, localParticipant, initialSyncDoneRef]);
}
