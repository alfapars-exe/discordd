/**
 * voiceJoinTiming — passive per-stage timing of one voice join attempt.
 *
 * The server cannot observe how long the client spends between asking for
 * credentials and being able to talk, so each attempt reports its own stage
 * times once, through logToServer. Marks never throw and never change how a
 * join runs; an attempt is identified by the voice store's _joinGeneration,
 * so a mark from a stale room or request is ignored.
 *
 * Only one attempt can be open: the store allows a single voice session, and
 * a new attempt replaces the open one. Nothing is kept per attempt beyond
 * that slot, so abandoned or superseded attempts cannot accumulate.
 *
 * The report carries the attempt kind and millisecond figures only — no
 * channel, server or user ids, names, tokens or URLs.
 */

import { logToServer } from "../api/clientLog";

export type VoiceJoinKind = "join" | "switch" | "move" | "rejoin";
export type VoiceJoinCredentialSource = "embedded" | "fetched";

type Attempt = {
  generation: number;
  kind: VoiceJoinKind;
  start: number;
  token?: number;
  credentials?: VoiceJoinCredentialSource;
  connected?: number;
  ready?: number;
  microphone?: number;
};

/** How long a ready attempt waits for the microphone publication before reporting. */
export const VOICE_JOIN_MICROPHONE_GRACE_MS = 5000;

let attempt: Attempt | null = null;
let graceTimer: ReturnType<typeof setTimeout> | undefined;

function open(generation: number): Attempt | null {
  return attempt && attempt.generation === generation ? attempt : null;
}

function since(start: number, mark: number | undefined): number | undefined {
  return mark === undefined ? undefined : Math.max(0, Math.round(mark - start));
}

/** Closes the open attempt; `report` false drops it without a log line. */
function close(report: boolean): void {
  const finished = attempt;
  attempt = null;
  if (graceTimer !== undefined) {
    clearTimeout(graceTimer);
    graceTimer = undefined;
  }
  if (!finished || !report) return;
  const reachedReady = finished.ready !== undefined;
  void logToServer("info", "voice_join_timing", {
    kind: finished.kind,
    outcome: reachedReady ? "ready" : "abandoned",
    // Last stage reached; for an abandoned attempt this is where it stopped.
    stage: reachedReady ? (finished.microphone !== undefined ? "microphone" : "ready")
      : finished.connected !== undefined ? "connected" : finished.token !== undefined ? "token" : "start",
    credentials: finished.credentials,
    // Every figure is milliseconds since the attempt started.
    token_ms: since(finished.start, finished.token),
    connected_ms: since(finished.start, finished.connected),
    ready_ms: since(finished.start, finished.ready),
    microphone_ms: since(finished.start, finished.microphone),
    elapsed_ms: reachedReady ? undefined : since(finished.start, performance.now()),
  });
}

/** joinVoiceChannel began. An attempt still open is superseded by this one. */
export function beginVoiceJoinTiming(generation: number, kind: VoiceJoinKind): void {
  // A superseded attempt that was already usable only lacked its microphone
  // figure, so it still reports; one that never became ready is dropped.
  if (attempt) close(attempt.ready !== undefined);
  attempt = { generation, kind, start: performance.now() };
}

/** Credentials were committed to the store. */
export function markVoiceJoinToken(generation: number, source: VoiceJoinCredentialSource): void {
  const current = open(generation);
  if (!current || current.token !== undefined) return;
  current.token = performance.now();
  current.credentials = source;
}

/** The LiveKit room reported connected. */
export function markVoiceJoinConnected(generation: number): void {
  const current = open(generation);
  if (current && current.connected === undefined) current.connected = performance.now();
}

/** Encrypted admission is ready: the session can publish and play media. */
export function markVoiceJoinReady(generation: number): void {
  const current = open(generation);
  if (!current || current.ready !== undefined) return;
  current.ready = performance.now();
  if (current.microphone !== undefined) { close(true); return; }
  // A muted or push-to-talk join publishes no microphone; do not wait forever.
  graceTimer = setTimeout(() => {
    graceTimer = undefined;
    if (open(generation)) close(true);
  }, VOICE_JOIN_MICROPHONE_GRACE_MS);
}

/** The microphone track was published. */
export function markVoiceJoinMicrophone(generation: number): void {
  const current = open(generation);
  if (!current || current.microphone !== undefined) return;
  current.microphone = performance.now();
  if (current.ready !== undefined) close(true);
}

/**
 * The store's join request settled. An attempt that never committed
 * credentials (refused, failed, cancelled) ends here; a committed one keeps
 * waiting for the room.
 */
export function settleVoiceJoinRequest(generation: number): void {
  const current = open(generation);
  if (current && current.token === undefined) close(true);
}

/** The voice session of this attempt ended before the attempt was reported. */
export function abandonVoiceJoinTiming(generation: number): void {
  if (open(generation)) close(true);
}

/** Test hook: forget the open attempt without reporting it. */
export function resetVoiceJoinTiming(): void {
  close(false);
}
