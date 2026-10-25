import { ConnectionState, Track, TrackPublication, type RemoteParticipant, type RemoteTrackPublication, type Room } from "livekit-client";
import { getAuthSessionSnapshot, subscribeAuthGenerationChanges, subscribeAuthOwnerChanges } from "../api/authSessionEvents";

export type VideoVisibilityScope = { room: Room; sessionNonce: string; keyContext: string; keyEpoch: number };
export type VideoViewport = { surface: "main" | "overlay"; visible: boolean; width: number; height: number; fps: number };
export type VideoViewportLease = { update(viewport: VideoViewport): boolean; release(): void };
export type VideoPublicationLease = { addViewport(viewport: VideoViewport): VideoViewportLease | null; refresh(): void; release(): void };
type Options = { scope: VideoVisibilityScope; currentScope: () => VideoVisibilityScope | null; isAdmitted: () => boolean; subscribeScope: (changed: () => void) => () => void };
type RecordState = { publication: RemoteTrackPublication; participant: RemoteParticipant; track: NonNullable<RemoteTrackPublication["track"]>; raw: MediaStreamTrack; authorizedSubscribed: () => boolean; views: Map<symbol, VideoViewport>; enabled?: boolean; dimensions?: { width: number; height: number }; fps?: number };
const owners = new WeakMap<RemoteTrackPublication, { coordinator: VideoVisibilityCoordinator; record: RecordState }>();
const MAX_VIEWS = 32;
const sameScope = (a: VideoVisibilityScope | null, b: VideoVisibilityScope) => !!a && a.room === b.room && a.sessionNonce === b.sessionNonce && a.keyContext === b.keyContext && a.keyEpoch === b.keyEpoch;
function viewport(value: VideoViewport): VideoViewport | null {
 if (!value || (value.surface !== "main" && value.surface !== "overlay") || typeof value.visible !== "boolean") return null;
 if (!value.visible) return { surface: value.surface, visible: false, width: 0, height: 0, fps: 0 };
 if (![value.width, value.height, value.fps].every(number => Number.isFinite(number) && number > 0)) return null;
 return { surface: value.surface, visible: true, width: Math.min(1920, Math.ceil(value.width)), height: Math.min(1080, Math.ceil(value.height)), fps: Math.min(60, Math.max(1, Math.floor(value.fps))) };
}

/** Public-SDK manual video policy only. No room options, subscriptions, audio,
 * capture, element visibility or PiP state are changed by this coordinator. */
export class VideoVisibilityCoordinator {
 private options: Options; private scope: VideoVisibilityScope; private auth = getAuthSessionSnapshot();
 private retired = false; private records = new Map<RemoteTrackPublication, RecordState>(); private cleanups: Array<() => void> = [];
 constructor(options: Options) {
  this.options = options; this.scope = { ...options.scope };
  const changed = () => this.refresh();
  this.cleanups.push(subscribeAuthOwnerChanges(changed), subscribeAuthGenerationChanges(changed));
  try { const off = options.subscribeScope(changed); if (this.retired) off(); else this.cleanups.push(off); } catch { this.dispose(); }
 }
 private current() { try { const auth = getAuthSessionSnapshot(); return !this.retired && !!this.scope.sessionNonce && !!this.scope.keyContext && Number.isSafeInteger(this.scope.keyEpoch) && this.scope.keyEpoch >= 0 && !!this.auth.ownerId && auth.ownerId === this.auth.ownerId && auth.generation === this.auth.generation && sameScope(this.options.currentScope(), this.scope); } catch { return false; } }
 private owns(record: RecordState) { return owners.get(record.publication)?.record === record && this.records.get(record.publication) === record; }
 private attached(record: RecordState) { const { publication, participant, track } = record; return this.scope.room.remoteParticipants.get(participant.identity) === participant && participant.trackPublications.get(publication.trackSid) === publication && publication.track === track && track.mediaStreamTrack === record.raw; }
 private manual(record: RecordState) { return this.scope.room.options.adaptiveStream === false && ("isAdaptiveStream" in record.track && record.track.isAdaptiveStream === false); }
 private disable(record: RecordState) { if (this.owns(record) && this.attached(record) && this.manual(record) && record.enabled !== false) { try { record.publication.setEnabled(false); record.enabled = false; } catch { record.enabled = undefined; } } }
 register(participant: RemoteParticipant, publication: RemoteTrackPublication, authorizedSubscribed: () => boolean): VideoPublicationLease | null {
  if (!this.current()) { this.dispose(); return null; }
  if (publication.kind !== Track.Kind.Video || publication.isLocal || !publication.track || publication.track.kind !== Track.Kind.Video) return null;
  const record: RecordState = { publication, participant, track: publication.track, raw: publication.track.mediaStreamTrack, authorizedSubscribed, views: new Map() };
  if (!this.attached(record) || !this.manual(record)) return null;
  const previous = owners.get(publication); previous?.coordinator.release(previous.record);
  this.records.set(publication, record); owners.set(publication, { coordinator: this, record }); this.reconcile(record);
  return { addViewport: value => this.addViewport(record, value), refresh: () => { if (this.owns(record)) this.refresh(); }, release: () => this.release(record) };
 }
 private addViewport(record: RecordState, value: VideoViewport): VideoViewportLease | null {
  if (!this.current() || !this.owns(record) || record.views.size >= MAX_VIEWS) return null;
  const normalized = viewport(value); if (!normalized) return null;
  const token = Symbol("video viewport"); record.views.set(token, normalized); this.reconcile(record);
  let active = true;
  return { update: next => { if (!active || !this.current() || !this.owns(record) || !record.views.has(token)) return false; const normalizedNext = viewport(next); if (normalizedNext) record.views.set(token, normalizedNext); else record.views.delete(token); this.reconcile(record); return !!normalizedNext; },
   release: () => { if (!active) return; active = false; if (!this.owns(record)) return; record.views.delete(token); this.reconcile(record); } };
 }
 private reconcile(record: RecordState) {
  if (!this.owns(record)) return;
  if (!this.current()) { this.dispose(); return; }
  if (!this.attached(record)) { this.release(record); return; }
  const publication = record.publication;
  // Existing adaptive Rooms must not receive sticky public manual overrides.
  // Integration creates manual-video Rooms explicitly; this core never does.
  const manual = this.manual(record);
  let authorized = false; try { authorized = record.authorizedSubscribed(); } catch { /* Fail closed. */ }
  let admitted = false; try { admitted = this.options.isAdmitted(); } catch { /* Fail closed. */ }
  const visible = [...record.views.values()].filter(value => value.visible);
  if (!manual || !admitted || this.scope.room.state !== ConnectionState.Connected || !authorized || !publication.isSubscribed || publication.permissionStatus !== TrackPublication.PermissionStatus.Allowed || record.raw.readyState === "ended" || visible.length === 0) { if (manual) this.disable(record); return; }
  const width = Math.max(...visible.map(value => value.width)), height = Math.max(...visible.map(value => value.height)), fps = Math.max(...visible.map(value => value.fps));
  try {
   if (record.dimensions?.width !== width || record.dimensions.height !== height) { publication.setVideoDimensions({ width, height }); record.dimensions = { width, height }; }
   if (record.fps !== fps) { publication.setVideoFPS(fps); record.fps = fps; }
   if (record.enabled !== true) { publication.setEnabled(true); record.enabled = true; }
  } catch { this.disable(record); }
 }
 refresh() { if (!this.current()) { this.dispose(); return; } for (const record of [...this.records.values()]) this.reconcile(record); }
 private release(record: RecordState) { if (!this.owns(record)) return; this.disable(record); this.records.delete(record.publication); owners.delete(record.publication); record.views.clear(); }
 dispose() { if (this.retired) return; this.retired = true; for (const record of [...this.records.values()]) this.release(record); const off = this.cleanups; this.cleanups = []; for (const cleanup of off) { try { cleanup(); } catch { /* Other leases must still retire. */ } } }
}
