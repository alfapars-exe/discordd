import { useEffect } from "react";
import { ConnectionState, RoomEvent, Track, type LocalParticipant, type Room } from "livekit-client";
import { getAuthSessionSnapshot, subscribeAuthGenerationChanges, subscribeAuthOwnerChanges } from "../api/authSessionEvents";
import { useAuthStore } from "../stores/authStore";
import { useVoiceStore } from "../stores/voiceStore";
import { useMemberStore } from "../stores/memberStore";
import { useChannelPermissionStore } from "../stores/channelPermissionStore";
import { useChannelStore } from "../stores/channelStore";
import { useServerStore } from "../stores/serverStore";
import { acquireOverlayGoLiveLease } from "../stores/overlayGoLiveStore";
import { canBrowserScreenShare, isElectron, isCapacitor } from "../utils/constants";
import { isNativeVoice } from "../utils/nativePlugins";
import { hasPermission, Permissions, resolveChannelPermissions } from "../utils/permissions";

/** Observe only: this never captures, publishes, toggles sharing or changes media state. */
export function attachOverlayGoLiveRoom(room: Room, participant: LocalParticipant): () => void {
  const scope = getAuthSessionSnapshot();
  const voice = useVoiceStore.getState();
  const serverId = voice.currentVoiceServerId, channelId = voice.currentVoiceChannelId;
  const joinGeneration = voice._joinGeneration;
  const lease = acquireOverlayGoLiveLease();
  let disposed = false, reconnecting = false;
  const current = () => {
    const auth = getAuthSessionSnapshot(), state = useVoiceStore.getState();
    return !disposed && !!scope.ownerId && auth.ownerId === scope.ownerId && auth.generation === scope.generation
      && useAuthStore.getState().user?.id === scope.ownerId && state.currentVoiceChannelId === channelId
      && state.currentVoiceServerId === serverId && state._joinGeneration === joinGeneration;
  };
  const update = () => {
    let eligible = false;
    const state = useVoiceStore.getState();
    if (current() && serverId && channelId && isElectron() && !isCapacitor() && !isNativeVoice() && canBrowserScreenShare()
      && state.voiceOverlayGoLive && !state.isStreaming && !state.isServerMuted
      && !reconnecting && room.state === ConnectionState.Connected && room.name === `${serverId}:${channelId}`
      && room.localParticipant === participant && participant.identity === scope.ownerId
      && participant.permissions?.canPublish === true
      && Array.isArray(participant.permissions.canPublishSources)
      && (participant.permissions.canPublishSources.length === 0 || participant.permissions.canPublishSources.includes(Track.sourceToProto(Track.Source.ScreenShare)))
      && !participant.getTrackPublication(Track.Source.ScreenShare)) {
      const members = useMemberStore.getState(), overrides = useChannelPermissionStore.getState();
      const load = overrides.statusByChannel[channelId];
      const member = members.membersByServer[serverId]?.find(entry => entry.id === scope.ownerId);
      const channel = useChannelStore.getState().categoriesByServer[serverId]?.flatMap(entry => entry.channels).find(entry => entry.id === channelId);
      if (member && Array.isArray(member.roles) && member.roles.every(role => role && typeof role.id === "string")
        && channel?.type === "voice" && useServerStore.getState().servers.some(entry => entry.id === serverId)
        && members.ownerId === scope.ownerId && members.authGeneration === scope.generation
        && members.statusByServer[serverId] === "ready" && !members.loadingServers.has(serverId)
        && load?.status === "ready" && load.ownerId === scope.ownerId && load.authGeneration === scope.generation
        && load.serverId === serverId && Array.isArray(overrides.overridesByChannel[channelId])) {
        const bits = resolveChannelPermissions(member.effective_permissions ?? 0, member.roles.map(role => role.id), overrides.overridesByChannel[channelId]);
        eligible = [Permissions.ViewChannel, Permissions.ConnectVoice, Permissions.Speak, Permissions.Stream].every(bit => hasPermission(bits, bit));
      }
    }
    lease.publish(eligible);
  };
  const suspend = () => { reconnecting = true; update(); };
  const resumed = () => { reconnecting = false; update(); };
  const subscriptions = [useVoiceStore, useAuthStore, useMemberStore, useChannelPermissionStore, useChannelStore, useServerStore].map(store => store.subscribe(update));
  subscriptions.push(subscribeAuthGenerationChanges(update), subscribeAuthOwnerChanges(update));
  const updates = [RoomEvent.ConnectionStateChanged, RoomEvent.ParticipantPermissionsChanged, RoomEvent.LocalTrackPublished, RoomEvent.LocalTrackUnpublished];
  for (const event of updates) room.on(event, update);
  room.on(RoomEvent.Reconnecting, suspend).on(RoomEvent.SignalReconnecting, suspend).on(RoomEvent.Disconnected, suspend);
  room.on(RoomEvent.Connected, resumed).on(RoomEvent.Reconnected, resumed);
  update();
  if (current() && serverId && channelId && voice.voiceOverlayGoLive) {
    void useMemberStore.getState().fetchMembers(serverId);
    void useChannelPermissionStore.getState().fetchOverrides(channelId, serverId);
  }
  return () => {
    disposed = true;
    subscriptions.forEach(unsubscribe => unsubscribe());
    for (const event of updates) room.off(event, update);
    room.off(RoomEvent.Reconnecting, suspend).off(RoomEvent.SignalReconnecting, suspend).off(RoomEvent.Disconnected, suspend);
    room.off(RoomEvent.Connected, resumed).off(RoomEvent.Reconnected, resumed);
    lease.release();
  };
}

export function useOverlayGoLiveReadiness(room: Room, participant: LocalParticipant): void {
  const owner = useAuthStore(state => state.user?.id);
  const generation = useAuthStore(() => getAuthSessionSnapshot().generation);
  const channel = useVoiceStore(state => state.currentVoiceChannelId);
  const server = useVoiceStore(state => state.currentVoiceServerId);
  const joined = useVoiceStore(state => state._joinGeneration);
  const enabled = useVoiceStore(state => state.voiceOverlayGoLive);
  useEffect(() => attachOverlayGoLiveRoom(room, participant), [room, participant, owner, generation, channel, server, joined, enabled]);
}
