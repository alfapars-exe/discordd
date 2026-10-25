import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { ConnectionState, RoomEvent, Track, type Room, type LocalParticipant } from "livekit-client";

const h = vi.hoisted(() => {
  function store() {
    let state: Record<string, unknown> = {};
    const listeners = new Set<() => void>();
    return { getState: () => state, setState: (value: Record<string, unknown>) => { state = { ...state, ...value }; listeners.forEach(fn => fn()); }, subscribe: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn); } };
  }
  return { voice: store(), auth: store(), members: store(), overrides: store(), channels: store(), servers: store(),
    scope: { ownerId: "owner", generation: 1 }, identityListeners: new Set<() => void>(), capture: true, electron: true, native: false, capacitor: false,
    fetchMembers: vi.fn(), fetchOverrides: vi.fn() };
});
vi.mock("../stores/voiceStore", () => ({ useVoiceStore: h.voice }));
vi.mock("../stores/authStore", () => ({ useAuthStore: h.auth }));
vi.mock("../stores/memberStore", () => ({ useMemberStore: h.members }));
vi.mock("../stores/channelPermissionStore", () => ({ useChannelPermissionStore: h.overrides }));
vi.mock("../stores/channelStore", () => ({ useChannelStore: h.channels }));
vi.mock("../stores/serverStore", () => ({ useServerStore: h.servers }));
vi.mock("../api/authSessionEvents", () => ({ getAuthSessionSnapshot: () => h.scope,
  subscribeAuthOwnerChanges: (fn: () => void) => { h.identityListeners.add(fn); return () => h.identityListeners.delete(fn); },
  subscribeAuthGenerationChanges: (fn: () => void) => { h.identityListeners.add(fn); return () => h.identityListeners.delete(fn); } }));
vi.mock("../utils/constants", () => ({ isElectron: () => h.electron, isCapacitor: () => h.capacitor, canBrowserScreenShare: () => h.capture }));
vi.mock("../utils/nativePlugins", () => ({ isNativeVoice: () => h.native }));
import { attachOverlayGoLiveRoom } from "./useOverlayGoLiveReadiness";
import { useOverlayGoLiveStore } from "../stores/overlayGoLiveStore";
import { Permissions } from "../utils/permissions";

const disposers: Array<() => void> = [];
const allowed = Permissions.ViewChannel | Permissions.ConnectVoice | Permissions.Speak | Permissions.Stream;
const member = (bits = allowed) => ({ id: "owner", effective_permissions: bits, roles: [{ id: "role" }] });
const acl = (status = "ready") => ({ channel: { status, serverId: "server", ownerId: "owner", authGeneration: 1 } });
beforeEach(() => {
  h.scope = { ownerId: "owner", generation: 1 }; h.capture = h.electron = true; h.native = false; h.capacitor = false;
  h.fetchMembers.mockReset().mockResolvedValue(undefined); h.fetchOverrides.mockReset().mockResolvedValue(undefined);
  h.auth.setState({ user: { id: "owner" } });
  h.voice.setState({ currentVoiceChannelId: "channel", currentVoiceServerId: "server", _joinGeneration: 1, voiceOverlayGoLive: true, isStreaming: false, isServerMuted: false });
  h.members.setState({ ownerId: "owner", authGeneration: 1, statusByServer: { server: "ready" }, loadingServers: new Set(), membersByServer: { server: [member()] }, fetchMembers: h.fetchMembers });
  h.overrides.setState({ statusByChannel: acl(), overridesByChannel: { channel: [] }, fetchOverrides: h.fetchOverrides });
  h.channels.setState({ categoriesByServer: { server: [{ channels: [{ id: "channel", type: "voice" }] }] } });
  h.servers.setState({ servers: [{ id: "server" }], activeServerId: "unrelated" });
});
afterEach(() => { disposers.splice(0).forEach(fn => fn()); expect(useOverlayGoLiveStore.getState().eligible).toBe(false); });
function setup(state = ConnectionState.Connected) {
  const publication = { present: false };
  const participant = { identity: "owner", permissions: { canPublish: true, canPublishSources: [] as number[] }, getTrackPublication: () => publication.present ? {} : undefined };
  const room = Object.assign(new EventEmitter(), { state, name: "server:channel", localParticipant: participant });
  const dispose = attachOverlayGoLiveRoom(room as unknown as Room, participant as unknown as LocalParticipant);
  disposers.push(dispose);
  return { room, participant, publication, dispose };
}
const eligible = () => useOverlayGoLiveStore.getState().eligible;

it("requires the actual connected SDK room and suppresses both reconnect paths until SDK recovery", () => {
  const { room } = setup(ConnectionState.Connecting);
  expect(eligible()).toBe(false);
  room.state = ConnectionState.Connected; room.emit(RoomEvent.Connected); expect(eligible()).toBe(true);
  room.emit(RoomEvent.SignalReconnecting); expect(eligible()).toBe(false);
  h.servers.setState({ activeServerId: "another-browsed-server" }); expect(eligible()).toBe(false);
  room.emit(RoomEvent.Reconnected); expect(eligible()).toBe(true);
  room.state = ConnectionState.Reconnecting; room.emit(RoomEvent.Reconnecting); expect(eligible()).toBe(false);
  room.state = ConnectionState.Connected; room.emit(RoomEvent.ConnectionStateChanged); expect(eligible()).toBe(false);
  room.emit(RoomEvent.Reconnected); expect(eligible()).toBe(true);
  room.emit(RoomEvent.Disconnected); expect(eligible()).toBe(false);
});
it("requires fresh connected-channel ACL and both SDK publish/source grants; cached allow never masks denial", () => {
  const { room, participant } = setup(); expect(eligible()).toBe(true);
  expect(h.fetchMembers).toHaveBeenCalledWith("server"); expect(h.fetchOverrides).toHaveBeenCalledWith("channel", "server");
  h.overrides.setState({ statusByChannel: acl("loading") }); expect(eligible()).toBe(false);
  h.overrides.setState({ statusByChannel: acl(), overridesByChannel: { channel: [{ role_id: "role", deny: Permissions.Stream, allow: 0 }] } }); expect(eligible()).toBe(false);
  h.overrides.setState({ overridesByChannel: { channel: [] } }); expect(eligible()).toBe(true);
  participant.permissions.canPublish = false; room.emit(RoomEvent.ParticipantPermissionsChanged); expect(eligible()).toBe(false);
  participant.permissions.canPublish = true; participant.permissions.canPublishSources = [Track.sourceToProto(Track.Source.Microphone)]; room.emit(RoomEvent.ParticipantPermissionsChanged); expect(eligible()).toBe(false);
  participant.permissions.canPublishSources = [Track.sourceToProto(Track.Source.ScreenShare)]; room.emit(RoomEvent.ParticipantPermissionsChanged); expect(eligible()).toBe(true);
  h.members.setState({ authGeneration: 0 }); expect(eligible()).toBe(false);
});
it("fences leave/rejoin and auth changes immediately; old room cleanup cannot erase a newer lease", () => {
  const first = setup(); expect(eligible()).toBe(true);
  const firstSession = useOverlayGoLiveStore.getState().session;
  h.voice.setState({ _joinGeneration: 2 }); expect(eligible()).toBe(false);
  first.room.emit(RoomEvent.Reconnected); expect(eligible()).toBe(false);
  const second = setup(); expect(eligible()).toBe(true);
  expect(useOverlayGoLiveStore.getState().session).not.toBe(firstSession);
  first.dispose(); expect(eligible()).toBe(true);
  second.room.name = "server:wrong-channel"; second.room.emit(RoomEvent.ConnectionStateChanged); expect(eligible()).toBe(false);
  second.room.name = "server:channel"; second.room.emit(RoomEvent.ConnectionStateChanged); expect(eligible()).toBe(true);
  h.scope = { ownerId: "owner", generation: 2 }; h.identityListeners.forEach(fn => fn()); expect(eligible()).toBe(false);
});
it("never advertises unavailable capture, native voice, existing streaming or missing participation", () => {
  const { room, publication } = setup(); expect(eligible()).toBe(true);
  h.capture = false; room.emit(RoomEvent.ConnectionStateChanged); expect(eligible()).toBe(false);
  h.capture = true; h.native = true; room.emit(RoomEvent.ConnectionStateChanged); expect(eligible()).toBe(false);
  h.native = false; h.capacitor = true; room.emit(RoomEvent.ConnectionStateChanged); expect(eligible()).toBe(false);
  h.capacitor = false; h.electron = false; room.emit(RoomEvent.ConnectionStateChanged); expect(eligible()).toBe(false);
  h.electron = true; h.voice.setState({ isStreaming: true }); expect(eligible()).toBe(false);
  h.voice.setState({ isStreaming: false }); publication.present = true; room.emit(RoomEvent.LocalTrackPublished); expect(eligible()).toBe(false);
  publication.present = false; room.emit(RoomEvent.LocalTrackUnpublished); expect(eligible()).toBe(true);
  h.voice.setState({ currentVoiceChannelId: null }); expect(eligible()).toBe(false);
});

it("fails closed for ready-but-malformed role snapshots without throwing from SDK callbacks", () => {
  const { room } = setup(); expect(eligible()).toBe(true);
  for (const roles of [null, undefined, {}, "role", [null], [{}], [{ id: 5 }]]) {
    expect(() => h.members.setState({ membersByServer: { server: [{ ...member(), roles }] } })).not.toThrow();
    expect(() => room.emit(RoomEvent.ParticipantPermissionsChanged)).not.toThrow();
    expect(eligible()).toBe(false);
  }
  h.members.setState({ membersByServer: { server: [member()] } });
  room.emit(RoomEvent.ParticipantPermissionsChanged);
  expect(eligible()).toBe(true);
});
