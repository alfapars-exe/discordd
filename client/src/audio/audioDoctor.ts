/**
 * audioDoctor — runtime diagnostic exposed on `window.__hichatAudioDoctor()`.
 *
 * Probes the local mic pipeline at every layer (raw mic → processor output →
 * sender track) and reports peak RMS for each, plus track state. Lets a user
 * paste a single console call output into a bug report and have us localise
 * which layer is dropping audio without round-trips for "now check this".
 *
 * Wired into the window object by side-effect import from VoiceStateManager,
 * but only in dev or when the explicit `hichat_audio_doctor=1` localStorage
 * flag is set — keeps prod console surface area minimal.
 */
import { Track } from "livekit-client";
import type { Room, LocalAudioTrack, RemoteAudioTrack } from "livekit-client";
import { useVoiceStore } from "../stores/voiceStore";

// Augment globalThis rather than Window — works in node-test environments
// and matches the project's lint preference (S7764). `var` is required here
// because TypeScript only treats `var` declarations as adding properties to
// the globalThis type (let/const create block-scoped bindings).
declare global {
  var __hichatRoom: Room | undefined;
  var __hichatAudioDoctor: (() => Promise<void>) | undefined;
}

/**
 * Open a 300 ms AnalyserNode on the given track and return the peak RMS
 * seen in that window. Returns null if the track is undefined so callers
 * can shape the report without conditionals.
 */
async function probePeakRms(mst: MediaStreamTrack | undefined): Promise<number | null> {
  if (!mst) return null;
  const ctx = new AudioContext();
  try {
    const src = ctx.createMediaStreamSource(new MediaStream([mst]));
    const an = ctx.createAnalyser();
    an.fftSize = 512;
    src.connect(an);
    const buf = new Uint8Array(an.fftSize);
    let peak = 0;
    const start = performance.now();
    while (performance.now() - start < 300) {
      an.getByteTimeDomainData(buf);
      let sum = 0;
      for (const sample of buf) {
        const v = (sample - 128) / 128;
        sum += v * v;
      }
      peak = Math.max(peak, Math.sqrt(sum / buf.length));
      await new Promise((r) => setTimeout(r, 16));
    }
    return peak;
  } finally {
    await ctx.close().catch(() => {
      /* already closed */
    });
  }
}

/**
 * Internal-only shape — LiveKit's LocalAudioTrack exposes `_mediaStreamTrack`,
 * `processor`, and `sender` but these aren't in the public type. We cast
 * narrowly here to keep the unsafe surface inside one helper.
 */
type LocalAudioTrackInternals = LocalAudioTrack & {
  _mediaStreamTrack?: MediaStreamTrack;
  processor?: {
    name?: string;
    processedTrack?: MediaStreamTrack;
  };
  sender?: RTCRtpSender;
};

type SerializableTrackInfo = {
  id: string;
  enabled: boolean;
  muted: boolean;
  readyState: MediaStreamTrackState;
  settings?: MediaTrackSettings;
} | null;

function describeTrack(mst: MediaStreamTrack | undefined): SerializableTrackInfo {
  if (!mst) return null;
  return {
    id: mst.id,
    enabled: mst.enabled,
    muted: mst.muted,
    readyState: mst.readyState,
    settings: typeof mst.getSettings === "function" ? mst.getSettings() : undefined,
  };
}

export async function audioDoctor(): Promise<void> {
  const room = globalThis.__hichatRoom;
  if (!room) {
    console.error("[hichat audio doctor] Room not exposed on globalThis. Are you connected to a voice channel?");
    return;
  }

  const lp = room.localParticipant;
  const pub = lp.getTrackPublication(Track.Source.Microphone);
  const track = pub?.track as LocalAudioTrackInternals | RemoteAudioTrack | undefined;
  const settings = useVoiceStore.getState();

  if (!track || !("setProcessor" in track)) {
    console.error("[hichat audio doctor] No local microphone track. Is the mic muted or not yet published?");
    return;
  }

  const localTrack = track;
  const rawMst = localTrack._mediaStreamTrack;
  const procMst = localTrack.processor?.processedTrack;
  const senderMst = localTrack.sender?.track ?? undefined;

  // Probe levels serially — running three AnalyserNodes in parallel doubles
  // CPU and gives nothing back, the user only speaks for 300 ms total.
  const rawPeak = await probePeakRms(rawMst);
  const procPeak = await probePeakRms(procMst);
  const senderPeak = await probePeakRms(senderMst);

  const report = {
    settings: {
      noiseReduction: settings.noiseReduction,
      engine: settings.noiseReductionEngine,
      inputVolume: settings.inputVolume,
      micSensitivity: settings.micSensitivity,
      level: settings.noiseSuppressionLevel,
    },
    pub: {
      isMuted: pub?.isMuted,
      source: pub?.source,
    },
    track: {
      hasProcessor: !!localTrack.processor,
      processorName: localTrack.processor?.name,
    },
    rawTrack: describeTrack(rawMst),
    processedTrack: describeTrack(procMst),
    senderTrack: senderMst
      ? {
          ...describeTrack(senderMst),
          sameAsProcessed: senderMst === procMst,
          sameAsRaw: senderMst === rawMst,
        }
      : null,
    levels: {
      raw_peak_rms: rawPeak,
      processed_peak_rms: procPeak,
      sender_peak_rms: senderPeak,
    },
  };

  console.log("[hichat audio doctor]\n" + JSON.stringify(report, null, 2));
}

if (import.meta.env.DEV || localStorage.getItem("hichat_audio_doctor") === "1") {
  globalThis.__hichatAudioDoctor = audioDoctor;
}
