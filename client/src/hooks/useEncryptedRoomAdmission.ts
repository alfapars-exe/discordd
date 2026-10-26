import {registerCaptureAdmission}from "../audio/microphoneAdmission";
import { useLayoutEffect, useRef, useState } from "react";
import { Room, RoomEvent, ConnectionState, type LocalTrack, type LocalTrackPublication, type Participant, type RoomOptions, Track } from "livekit-client";
import type { IndexedVoiceKeyProvider } from "../audio/voiceEncryptionKeys";
import { mediaTokenSubject } from "../audio/voiceEncryptionKeys";
import { getAuthSessionSnapshot, subscribeAuthOwnerChanges, subscribeAuthGenerationChanges } from "../api/authSessionEvents";

const stopOwnedTrack = (track: LocalTrack | MediaStreamTrack) => {
  if ("mediaStreamTrack" in track) track.mediaStreamTrack.enabled = false;
  else track.enabled = false;
  track.stop();
};
type Paused = { media: MediaStreamTrack; enabled: boolean; source: Track.Source };
type Binding = {
  room: Room; scope: string; active: boolean; admitted: boolean; ready: boolean;
  keyScope: string; revision: number; error: unknown; paused: Map<LocalTrack, Paused>; pending: Set<LocalTrack | MediaStreamTrack>; captureLease:ReturnType<typeof registerCaptureAdmission>;
};
type Options = {
  enabled: boolean; token: string; scope: string; keyScope: string; keyReady: boolean; keyError: unknown;
  keyProvider: IndexedVoiceKeyProvider; worker: Worker | null; roomOptions: RoomOptions;
  onError: (error: unknown) => void; isCurrentSource?:()=>boolean; allowRestore?: (source: Track.Source) => boolean;
};

/** No connection or publisher is admitted until indexed key material and
 * explicit SDK GCM enable finish. Rekey pauses exact current tracks in the
 * layout phase while preserving the room; fatal errors never fall back. */
export function useEncryptedRoomAdmission(options: Options) {
  const { enabled, scope, keyScope, keyReady, keyError, keyProvider, worker } = options;
  const tokenOwner = mediaTokenSubject(options.token);
  const latest = useRef(options);
  useLayoutEffect(() => { latest.current = options; });
  const [binding, setBinding] = useState<Binding | null>(null);
  const [, changed] = useState(0);
  const [reconnectRevision, reconnect] = useState(0);
  const [roomFailure, setRoomFailure] = useState<{ scope: string; error: unknown } | null>(null);

  useLayoutEffect(() => {
    if (!enabled || !worker) return;
    const authScope = JSON.stringify(getAuthSessionSnapshot());
    if (!tokenOwner || tokenOwner !== getAuthSessionSnapshot().ownerId) {
      const error = new Error("Media credentials belong to another session");
      queueMicrotask(() => { if (latest.current.scope === scope) { setRoomFailure({ scope, error }); latest.current.onError(error); } });
      return;
    }
    let room: Room;
    try { room = new Room({ ...latest.current.roomOptions, e2ee: { keyProvider, worker } }); }
    catch (error) { queueMicrotask(() => { if (latest.current.enabled && latest.current.scope === scope) { setRoomFailure({ scope, error }); latest.current.onError(error); } }); return; }
    const record: Binding = { room,
      scope, active: true, admitted: false, ready: false, keyScope: "", revision: 0, error: null, paused: new Map(), pending: new Set(), captureLease:registerCaptureAdmission(room.localParticipant,()=>record.active&&record.ready&&!record.error&&latest.current.keyReady&&latest.current.keyScope===record.keyScope&&JSON.stringify(getAuthSessionSnapshot())===authScope&&latest.current.isCurrentSource?.()!==false) };
    const pause = (publication: LocalTrackPublication) => {
      const track = publication.track;
      if (!track) return;
      const media = track.mediaStreamTrack;
      if (!record.paused.has(track)) record.paused.set(track, { media, enabled: media.enabled, source: publication.source });
      media.enabled = false;
    };
    const pauseAll = () => { record.captureLease.close();record.room.localParticipant.trackPublications.forEach(pause); record.pending.forEach(stopOwnedTrack); };
    // Unmount cannot cancel SDK getUserMedia. Fence capture completion and
    // publication on this exact Room, including work started before rekey.
    const participant = room.localParticipant;
    const captureVersions = new WeakMap<object, number>();
    const publicationCurrent = (version: number) => record.active && record.ready && !record.error
      && record.revision === version && latest.current.keyReady && latest.current.keyScope === record.keyScope
      && JSON.stringify(getAuthSessionSnapshot()) === authScope && latest.current.isCurrentSource?.() !== false;
    const createTracks = participant.createTracks.bind(participant);
    participant.createTracks = async (...args: Parameters<typeof createTracks>) => {
      const version = record.revision;
      if (!publicationCurrent(version)) throw new Error("Encrypted capture is not admitted");
      const tracks = await createTracks(...args);
      if (!publicationCurrent(version)) { tracks.forEach(stopOwnedTrack); throw new Error("Encrypted capture scope changed"); }
      tracks.forEach((track) => captureVersions.set(track, version));
      return tracks;
    };
    const createScreenTracks = participant.createScreenTracks.bind(participant);
    participant.createScreenTracks = async (...args: Parameters<typeof createScreenTracks>) => {
      const version = record.revision;
      if (!publicationCurrent(version)) throw new Error("Encrypted capture is not admitted");
      const tracks = await createScreenTracks(...args);
      if (!publicationCurrent(version)) { tracks.forEach(stopOwnedTrack); throw new Error("Encrypted capture scope changed"); }
      tracks.forEach((track) => captureVersions.set(track, version));
      return tracks;
    };
    const publishTrack = participant.publishTrack.bind(participant);
    participant.publishTrack = async (...args: Parameters<typeof publishTrack>) => {
      const [track] = args;
      const version = captureVersions.get(track) ?? record.revision;
      if (!publicationCurrent(version)) { stopOwnedTrack(track); throw new Error("Encrypted publication is not admitted"); }
      record.pending.add(track);
      try {
        const publication = await publishTrack(...args);
        if (!publicationCurrent(version)) {
          stopOwnedTrack(track);
          if (publication.track === track) await participant.unpublishTrack(track);
          throw new Error("Encrypted publication scope changed");
        }
        return publication;
      } finally { record.pending.delete(track); }
    };
    const fatal = (error: unknown, participant?: Participant) => {
      // The SDK drops undecipherable remote frames. A remote sender with an
      // obsolete/wrong key must not retire our valid local encryption context
      // and disconnect every other participant. Local/worker failures remain fatal.
      if (participant && participant !== record.room.localParticipant && participant.identity !== tokenOwner) return;
      if (!record.active) return;
      record.ready = false; record.error = error; record.revision++; pauseAll();
      void record.room.disconnect();
      if (JSON.stringify(getAuthSessionSnapshot()) === authScope) { latest.current.onError(error); changed((value) => value + 1); }
    };
    const published = (publication: LocalTrackPublication) => { if (!record.ready) pause(publication); };
    record.room.on(RoomEvent.LocalTrackPublished, published);
    record.room.on(RoomEvent.EncryptionError, fatal);
    const reconnecting = () => { record.ready = false; record.revision++; pauseAll(); changed((value) => value + 1); };
    const reconnected = () => { if (record.active) reconnect((value) => value + 1); };
    record.room.on(RoomEvent.Reconnecting, reconnecting);
    record.room.on(RoomEvent.SignalReconnecting, reconnecting);
    record.room.on(RoomEvent.Reconnected, reconnected);
    const retireAuth = () => {
      if (JSON.stringify(getAuthSessionSnapshot()) === authScope) return;
      record.active = false; record.ready = false; record.revision++; pauseAll();record.captureLease.retire(); void record.room.disconnect(); changed((value) => value + 1);
    };
    const ownerSubscription = subscribeAuthOwnerChanges(retireAuth), generationSubscription = subscribeAuthGenerationChanges(retireAuth);
    queueMicrotask(() => { if (record.active && JSON.stringify(getAuthSessionSnapshot()) === authScope) { setRoomFailure(null); setBinding(record); } });
    return () => {
      record.active = false; record.ready = false; record.revision++; pauseAll();record.captureLease.retire();
      ownerSubscription(); generationSubscription();
      record.room.off(RoomEvent.LocalTrackPublished, published);
      record.room.off(RoomEvent.EncryptionError, fatal);
      record.room.off(RoomEvent.Reconnecting, reconnecting);
      record.room.off(RoomEvent.SignalReconnecting, reconnecting);
      record.room.off(RoomEvent.Reconnected, reconnected);
      void record.room.disconnect();
    };
  }, [enabled, scope, keyProvider, worker, tokenOwner]);

  useLayoutEffect(() => {
    if (!binding || !binding.active || binding.scope !== scope || !enabled) return;
    const record = binding;
    const revision = ++record.revision;
    const authScope = JSON.stringify(getAuthSessionSnapshot());
    record.ready = false;record.captureLease.close();
    record.pending.forEach(stopOwnedTrack);
    record.room.localParticipant.trackPublications.forEach((publication) => {
      const track = publication.track;
      if (!track) return;
      const media = track.mediaStreamTrack;
      if (!record.paused.has(track)) record.paused.set(track, { media, enabled: media.enabled, source: publication.source });
      media.enabled = false;
    });
    if (keyError) {
      record.error = keyError; void record.room.disconnect();
      return;
    }
    if (!keyReady || record.error) return;
    let active = true;
    const current = () => active && record.active && record.revision === revision
      && latest.current.scope === scope && latest.current.keyScope === keyScope && latest.current.keyReady
      && latest.current.isCurrentSource?.() !== false && JSON.stringify(getAuthSessionSnapshot()) === authScope && mediaTokenSubject(latest.current.token) === getAuthSessionSnapshot().ownerId;
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Encrypted media admission timed out")), 10_000);
    });
    let removeAcknowledgement = () => {};
    let removeConnectionWait = () => {};
    const enable = async () => {
      await record.room.setE2EEEnabled(true);
      if (!current() || !worker) return false;
      // Transport may connect only after LocalParticipant's GCM flag is set,
      // but no capture/control owner is mounted until the real owner's ACK.
      record.admitted = true; changed((value) => value + 1);
      await new Promise<void>((resolve, reject) => {
        const connected = () => {
          if (!current() || record.room.state !== ConnectionState.Connected) return;
          if (record.room.localParticipant.identity !== mediaTokenSubject(latest.current.token)) { reject(new Error("Connected media identity does not match current owner")); return; }
          resolve();
        };
        record.room.on(RoomEvent.Connected, connected);
        record.room.on(RoomEvent.Reconnected, connected);
        removeConnectionWait = () => { record.room.off(RoomEvent.Connected, connected); record.room.off(RoomEvent.Reconnected, connected); };
        connected();
      });
      if (!current()) return false;
      const identity = record.room.localParticipant.identity;
      if (!identity || identity !== getAuthSessionSnapshot().ownerId) throw new Error("Encrypted media owner is unavailable");
      const request = crypto.randomUUID();
      await new Promise<void>((resolve) => {
        const acknowledge = (event: MessageEvent) => {
          const message = event.data as { kind?: string; data?: { enabled?: boolean; participantIdentity?: string; hichatRequestId?: string } };
          if (message?.kind === "enable" && message.data?.enabled === true && message.data.participantIdentity === identity
            && message.data.hichatRequestId === request && current()) resolve();
        };
        worker.addEventListener("message", acknowledge);
        removeAcknowledgement = () => worker.removeEventListener("message", acknowledge);
        // Installed SDK worker serializes setKey/enable through messageQueue,
        // and echoes enable only AFTER previous key derivation completes.
        worker.postMessage({ kind: "enable", data: { enabled: true, participantIdentity: identity, hichatRequestId: request } });
      });
      return true;
    };
    void Promise.race([enable(), timeout]).then((enabled) => {
      if (!enabled || !current()) return;
      record.keyScope = keyScope; record.ready = true; record.admitted = true;record.captureLease.open();
      for (const [track, paused] of record.paused) {
        const stillPublished = [...record.room.localParticipant.trackPublications.values()].some((publication) => publication.track === track);
        if (stillPublished && track.mediaStreamTrack === paused.media && paused.media.readyState !== "ended"
          && !track.isMuted && (latest.current.allowRestore?.(paused.source) ?? true)) paused.media.enabled = paused.enabled;
      }
      record.paused.clear(); changed((value) => value + 1);
    }).catch((error: unknown) => {
      if (!current()) return;
      record.error = error; record.ready = false; void record.room.disconnect();
      latest.current.onError(error); changed((value) => value + 1);
    }).finally(() => { clearTimeout(timer); removeAcknowledgement(); removeConnectionWait(); });
    return () => { active = false; clearTimeout(timer); removeAcknowledgement(); removeConnectionWait(); };
  }, [binding, enabled, scope, keyScope, keyReady, keyError, reconnectRevision, worker]);

  const current = enabled && binding?.active && binding.scope === scope;
  return {
    room: current ? binding.room : null,
    connect: Boolean(current && binding.admitted && !binding.error && !keyError),
    publishReady: Boolean(current && binding.ready && binding.keyScope === keyScope && keyReady && !keyError && !binding.error && options.isCurrentSource?.() !== false),
    error: keyError ?? (roomFailure?.scope === scope ? roomFailure.error : null) ?? (current ? binding.error : null),
  };
}
