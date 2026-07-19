/**
 * micProfile — pure mapping from the user's microphone profile to the LiveKit
 * capture + publish options for the mic track.
 *
 * Two profiles, deliberately opposite:
 *
 *   "konusma" (speech, default) — the historical HiChat behaviour. Mono
 *     capture with the browser's full voice DSP chain (AEC / NS / AGC) on,
 *     the RNNoise-family processor attached on top, and the Opus speech
 *     features (DTX + RED) enabled. Optimised for intelligibility over a
 *     lossy link, which is what a voice channel is 95 % of the time.
 *
 *   "muzik" (music) — for anyone routing an instrument, a virtual audio
 *     cable, or a decent condenser into the channel. Every stage that was
 *     trained on or tuned for speech is switched off:
 *       - browser AEC/NS/AGC off: AGC pumps on sustained tone, NS treats a
 *         held note as stationary noise, AEC's nonlinear processing smears
 *         transients.
 *       - RNNoise / DeepFilterNet3 / DTLN bypassed entirely — see
 *         shouldRunNoiseProcessor. These are speech-trained models; on music
 *         they don't merely fail to help, they actively gut the signal.
 *       - stereo capture + forced stereo publish, DTX and RED off.
 *
 * This mirrors the screen-share audio profile in
 * useScreenSharePublishDefaults.ts (SCREEN_SHARE_AUDIO_PUBLISH), which solved
 * the same "voice DSP is destroying media audio" problem for stream audio —
 * with one deliberate difference, documented on MUSIC_MIC_PUBLISH below.
 *
 * Kept dependency-free (type-only imports) so it stays cheap to unit test:
 * livekit-client is a runtime SDK, so the option objects themselves are the
 * only thing worth asserting on.
 */

import type { AudioCaptureOptions, AudioPreset } from "livekit-client";
import type { MicProfile } from "../stores/slices/voiceSettingsSlice";

/** Every declared profile, so tests and UI can enumerate exhaustively. */
export const MIC_PROFILES = ["konusma", "muzik"] as const;

/**
 * Bitrate ceiling for the music profile. Opus treats maxBitrate as a ceiling
 * rather than a target, so this is headroom for transparent stereo music, not
 * a constant 256 kbps spend.
 *
 * Note this is a fixed value rather than the per-channel voice bitrate (see
 * VoiceProvider's DEFAULT_VOICE_BITRATE, 384 kbps): the music profile is
 * deliberately decoupled from the channel's voice setting, exactly like
 * SCREEN_SHARE_AUDIO_PRESET is, so an admin lowering a channel's voice
 * quality can't silently degrade someone's music feed — and so a channel
 * configured very high can't push a stereo Opus stream past the point of
 * transparency for no audible gain.
 */
export const MUSIC_MIC_BITRATE = 256_000;

/** The publish-side half of a profile — the 3rd arg of setMicrophoneEnabled. */
export type MicPublishOptions = {
  /** Only set on the music path; the speech path inherits the per-channel
   *  Opus preset from RoomOptions.publishDefaults. */
  audioPreset?: AudioPreset;
  dtx: boolean;
  red: boolean;
  forceStereo: boolean;
};

/**
 * Speech publish profile. DTX and RED are livekit-client's defaults for mono
 * tracks today, but they are pinned explicitly here for two reasons: it
 * documents the intent right next to the contrasting music profile, and it
 * makes the speech path assertable in a unit test instead of being an
 * invisible SDK default that could shift in a minor release.
 *
 *   - dtx: true — Discontinuous Transmission. Stops sending during silence,
 *     which is most of a voice call. Big upstream saving, speech-only feature.
 *   - red: true — Redundant Audio Data (RFC 2198). Piggybacks previous frames
 *     so a single lost packet doesn't become a gap. Costs ~2x audio bitrate,
 *     which is trivial at speech rates.
 *
 * No audioPreset: publish options are merged OVER RoomOptions.publishDefaults
 * by the SDK, so omitting it lets VoiceProvider's per-channel bitrate keep
 * applying. Setting it here would silently override the channel slider.
 */
const SPEECH_MIC_PUBLISH: MicPublishOptions = {
  dtx: true,
  red: true,
  forceStereo: false,
};

/**
 * Music publish profile.
 *
 * Both DTX and RED are off here, and livekit-client would default them off
 * for a stereo track anyway (LocalParticipant.publish, ~27071 in the 2.17
 * ESM bundle: `if (isStereo) { opts.dtx ??= false; opts.red ??= false }`).
 * We state them explicitly so the choice is visible and testable rather than
 * inherited — pinned by a unit assertion in micProfile.test.ts.
 *
 * Note the SDK's own log line reads "Opus RED will be disabled for stereo
 * tracks by default. Enable them explicitly to make it work." — so stereo +
 * RED is a supported opt-in, not a broken combination. Turning RED off here
 * is a BANDWIDTH decision, not a correctness one: RED roughly doubles audio
 * bitrate, which is trivial at speech rates but means ~512 kbps of upstream
 * for a 256 kbps stereo music feed. A microphone-sourced music stream is a
 * niche path and rarely worth that, so it stays off.
 *
 * SCREEN_SHARE_AUDIO_PUBLISH makes the opposite call — `red: true` with
 * `forceStereo: true` — and that is deliberate and correct for its case:
 * shared media audio is the one place where a single lost packet is most
 * audible, so it buys loss resilience with bandwidth it already budgeted.
 * The two profiles differ on purpose; neither is a bug.
 */
const MUSIC_MIC_PUBLISH: MicPublishOptions = {
  audioPreset: { maxBitrate: MUSIC_MIC_BITRATE },
  // DTX gates low-level passages as "silence"; on music that is audible
  // pumping / warble on reverb tails and sustained notes.
  dtx: false,
  // Off for bandwidth, not correctness — see the note above.
  red: false,
  // Force rather than infer: getSettings().channelCount is unreliable
  // (Safari-only in practice), so without this the SDK falls back to mono
  // and the whole profile is silently pointless.
  forceStereo: true,
};

/**
 * Capture constraints for a profile. `deviceId` is threaded through rather
 * than baked in because the device picker is orthogonal to the profile.
 *
 * An empty `inputDevice` means "browser default" and must omit the key
 * entirely — `deviceId: ""` is a real (unsatisfiable) constraint on some
 * builds and makes getUserMedia throw OverconstrainedError.
 */
export function micCaptureFor(
  profile: MicProfile,
  inputDevice: string,
): AudioCaptureOptions {
  const device = inputDevice ? { deviceId: inputDevice } : {};

  if (profile === "muzik") {
    return {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 2,
      ...device,
    };
  }

  return {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    // Mono capture on the speech path. Some USB / virtual mics expose two
    // channels with one silent; without this the silent channel feeds half
    // the playback graph on remotes and shows up as "audio only in one ear".
    channelCount: 1,
    ...device,
  };
}

/** Publish options for a profile — the 3rd arg of setMicrophoneEnabled. */
export function micPublishFor(profile: MicProfile): MicPublishOptions {
  return profile === "muzik" ? MUSIC_MIC_PUBLISH : SPEECH_MIC_PUBLISH;
}

/**
 * Whether the noise-suppression processor chain (RNNoise / DeepFilterNet3 /
 * DTLN / Speex / Krisp / VAD gate) should be attached to the mic track.
 *
 * False on the music profile: every engine in that chain is speech-trained
 * and destroys music. Gating here rather than inside useAudioProcessor keeps
 * the decision a pure, testable function — useAudioProcessor imports WASM
 * engines at module scope and is not cheaply unit-testable.
 */
export function shouldRunNoiseProcessor(profile: MicProfile): boolean {
  return profile === "konusma";
}
