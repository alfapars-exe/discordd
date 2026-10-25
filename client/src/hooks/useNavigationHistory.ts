import { useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { HOME_DESTINATION, useUIStore, type Destination, type TabType } from "../stores/uiStore";
import { useServerStore } from "../stores/serverStore";
import { useChannelStore } from "../stores/channelStore";
import { useDMStore } from "../stores/dmStore";
import { useGroupDMStore } from "../stores/groupDMStore";
import { useP2PCallStore } from "../stores/p2pCallStore";
import { useAuthStore } from "../stores/authStore";
import { getAuthSessionSnapshot } from "../api/authSessionEvents";
import { UI_SHELL_V2 } from "../utils/uiShell";
import { observeShortcutDestinationTransition, resetShortcutDestinationHistory } from "../utils/shortcutNavigation";
import { observeAppRoute, resetAppRouteHistory, stepAppRouteHistory } from "../utils/appRouteHistory";

const homeTypes = new Set<TabType>(["friends", "inbox", "notifications", "saved"]);
const serverTypes = new Set<TabType>(["text", "voice", "screen", "audit"]);

export function destinationPath(destination: Destination): string {
  const id = encodeURIComponent(destination.channelId);
  if (destination.serverInfo) {
    const server = encodeURIComponent(destination.serverInfo.serverId);
    return destination.type === "server-home" ? `/channels/server/${server}` : `/channels/server/${server}/${destination.type}/${id}`;
  }
  if (destination.type === "dm" || destination.type === "p2p") return `/channels/${destination.type}/${id}`;
  if (destination.type === "group-dm") return `/channels/group/${id}`;
  return `/channels/@me/${homeTypes.has(destination.type as TabType) ? destination.type : "friends"}`;
}

/** Resolve IDs from current stores, never trust labels or server metadata in history. */
export function destinationFromPath(path: string): Destination | null {
  let parts: string[];
  try { parts = path.split("/").filter(Boolean).map(decodeURIComponent); } catch { return HOME_DESTINATION; }
  if (parts[0] !== "channels") return HOME_DESTINATION;
  if (parts.length === 1) return HOME_DESTINATION;
  if (parts[1] === "@me" && parts.length <= 3) {
    const type = (parts[2] ?? "friends") as TabType;
    return homeTypes.has(type) ? { type, channelId: type, label: "" } : HOME_DESTINATION;
  }
  if (parts[1] === "dm" && parts.length === 3) {
    const channel = useDMStore.getState().channels.find((item) => item.id === parts[2]);
    return { type: "dm", channelId: parts[2], label: channel?.other_user.display_name || channel?.other_user.username || "" };
  }
  if (parts[1] === "group" && parts.length === 3) {
    const session = getAuthSessionSnapshot();
    const owner = useAuthStore.getState().user?.id;
    const state = useGroupDMStore.getState();
    // A cold page starts with an empty cache. It is not authoritative proof
    // that the requested group was deleted or the viewer lost membership.
    if (!owner || session.ownerId !== owner || state.ownerId !== owner
      || state.authGeneration !== session.generation || !state.groupsReady) return null;
    const group = state.groups.find((item) => item.id === parts[2]);
    return group?.members.some((member) => member.id === owner)
      ? { type: "group-dm", channelId: group.id, label: group.name } : HOME_DESTINATION;
  }
  if (parts[1] === "p2p" && parts.length === 3) {
    return useP2PCallStore.getState().activeCall?.id === parts[2]
      ? { type: "p2p", channelId: parts[2], label: "" } : HOME_DESTINATION;
  }
  if (parts[1] === "server" && (parts.length === 3 || parts.length === 5)) {
    const servers = useServerStore.getState().servers;
    const server = servers.find((item) => item.id === parts[2]);
    if (!server) return servers.length === 0 ? null : HOME_DESTINATION;
    const serverInfo = { serverId: server.id, serverName: server.name, serverIconUrl: server.icon_url };
    const type = parts[3] as TabType | undefined;
    if (parts.length === 3 || !type || !serverTypes.has(type)) {
      return { type: "server-home", channelId: server.id, label: server.name, serverInfo };
    }
    const channel = useChannelStore.getState().categoriesByServer[server.id]?.flatMap((group) => group.channels).find((item) => item.id === parts[4]);
    return { type, channelId: parts[4], label: channel?.name ?? "", serverInfo };
  }
  return HOME_DESTINATION;
}

/** Mount once within Router. Works with both BrowserRouter and native HashRouter. */
export function useNavigationHistory() {
  const location = useLocation();
  const routerNavigate = useNavigate();
  const servers = useServerStore((state) => state.servers);
  const groups = useGroupDMStore((state) => state.groups);
  const groupsReady = useGroupDMStore((state) => state.groupsReady);
  const groupOwner = useGroupDMStore((state) => state.ownerId);
  const groupGeneration = useGroupDMStore((state) => state.authGeneration);
  const owner = useAuthStore((state) => state.user?.id);
  const generation = getAuthSessionSnapshot().generation;
  const applyingHistory = useRef(false);
  const pathRef = useRef(location.pathname);
  const writtenPath = useRef<string | null>(null);
  const appliedLocation = useRef<string | null>(null);

  useEffect(() => {
    observeAppRoute(location.pathname);
    if (!UI_SHELL_V2) return;
    pathRef.current = location.pathname;
    const locationScope = JSON.stringify([owner, generation, location.key]);
    if (writtenPath.current === location.pathname) {
      writtenPath.current = null;
      appliedLocation.current = locationScope;
      return;
    }
    if (appliedLocation.current === locationScope) return;
    const target = destinationFromPath(location.pathname);
    if (!target) return; // Server/group membership is not populated for this account yet.
    appliedLocation.current = locationScope;
    applyingHistory.current = true;
    useUIStore.getState().navigate(target);
    applyingHistory.current = false;
    const canonical = destinationPath(useUIStore.getState().destination);
    if (canonical !== location.pathname) {
      writtenPath.current = canonical;
      pathRef.current = canonical;
      void routerNavigate(canonical, { replace: true });
    }
  }, [location.pathname, location.key, servers, groups, groupsReady, groupOwner, groupGeneration, owner, generation, routerNavigate]);

  useEffect(() => {
    const goHistory = (direction: -1 | 1) => {
      const path = stepAppRouteHistory(direction);
      if (path) void routerNavigate(path);
    };
    const back = () => goHistory(-1);
    const forward = () => goHistory(1);
    window.addEventListener("hichat:history-back", back);
    window.addEventListener("hichat:history-forward", forward);
    let currentUserId = useAuthStore.getState().user?.id;
    const unsubscribeAuth = useAuthStore.subscribe((state, previous) => {
      if (state.user?.id === previous.user?.id || state.user?.id === currentUserId) return;
      currentUserId = state.user?.id;
      resetAppRouteHistory();
      resetShortcutDestinationHistory();
      observeAppRoute(destinationPath(useUIStore.getState().destination));
    });
    return () => {
      window.removeEventListener("hichat:history-back", back);
      window.removeEventListener("hichat:history-forward", forward);
      unsubscribeAuth();
    };
  }, [location.pathname, routerNavigate]);

  useEffect(() => {
    if (!UI_SHELL_V2) return;
    return useUIStore.subscribe((state, previous) => {
      if (state.destination !== previous.destination) observeShortcutDestinationTransition(previous.destination, state.destination);
      if (applyingHistory.current || state.navigationRevision === previous.navigationRevision) return;
      const path = destinationPath(state.destination);
      if (path === pathRef.current) return;
      observeAppRoute(path);
      writtenPath.current = path;
      pathRef.current = path;
      void routerNavigate(path);
    });
  }, [routerNavigate]);
}
