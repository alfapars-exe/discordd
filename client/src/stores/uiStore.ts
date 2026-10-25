/**
 * uiStore — VS Code-style tab management + split pane layout state.
 *
 * Single responsibility (post-refactor): coordinate tab + panel state.
 * The pure layout-tree algebra lives in utils/layoutTree.ts so that this
 * store stays focused on orchestration: which tabs exist in which panels,
 * what's active, and which side effects fire when something closes.
 */

import { create } from "zustand";
import { useVoiceStore } from "./voiceStore";
import { useMessageStore } from "./messageStore";
import { useReadStateStore } from "./readStateStore";
import { useServerStore } from "./serverStore";
import { useChannelStore } from "./channelStore";
import { useDMStore } from "./dmStore";
import { useMobileStore } from "./mobileStore";
import { UI_SHELL_V2 } from "../utils/uiShell";
import {
  insertSplit,
  type LayoutNode,
  removeLeafFromLayout,
  type SplitDirection,
  updateRatioAtPath,
} from "../utils/layoutTree";
// Re-export so existing imports of these types from "stores/uiStore" still work.
export type { LayoutNode, SplitDirection } from "../utils/layoutTree";

// ──────────────────────────────────
// Types
// ──────────────────────────────────

export type TabType =
  | "text"
  | "voice"
  | "screen"
  | "dm"
  | "group-dm"
  | "friends"
  | "p2p"
  | "audit"
  | "inbox"
  | "notifications"
  | "saved";

/** Server info for multi-server tab disambiguation. Not needed for DM/friends/p2p. */
export type TabServerInfo = {
  serverId: string;
  serverName: string;
  serverIconUrl: string | null;
};

export type ServerEventsTarget = {
  serverId: string;
  serverName: string;
  eventId?: string;
  expectedUserId: string;
  authGeneration: number;
};

export type Tab = {
  id: string;
  channelId: string;
  type: TabType;
  label: string;
  /** Required for text/voice tabs, undefined for DM/friends/p2p */
  serverInfo?: TabServerInfo;
  hasUnread?: boolean;
};

export type Panel = {
  id: string;
  tabs: Tab[];
  activeTabId: string | null;
};

/** The new shell has one destination, independent of the lifetime of a call. */
export type Destination = Omit<Tab, "id" | "hasUnread" | "type"> & {
  type: TabType | "server-home";
};

export const HOME_DESTINATION: Destination = { type: "friends", channelId: "friends", label: "" };

function serverDestination(serverInfo: TabServerInfo): Destination {
  return { type: "server-home", channelId: serverInfo.serverId, label: serverInfo.serverName, serverInfo };
}

// ──────────────────────────────────
// Store interface
// ──────────────────────────────────

type UIState = {
  destination: Destination;
  navigationRevision: number;
  lastChannelByServer: Record<string, Destination>;
  navigate: (destination: Destination, options?: { closeDrawers?: boolean }) => void;
  openServer: (serverId: string) => void;
  closeDestination: (channelId: string) => void;
  resetNavigation: () => void;
  panels: Record<string, Panel>;
  layout: LayoutNode;
  activePanelId: string;
  membersOpen: boolean;
  quickSwitcherOpen: boolean;
  serverEventsTarget: ServerEventsTarget | null;
  openServerEvents: (target: ServerEventsTarget) => void;
  closeServerEvents: () => void;

  // Tab actions
  openTab: (channelId: string, type: TabType, label: string, serverInfo?: TabServerInfo) => void;
  closeTab: (panelId: string, tabId: string) => void;
  setActiveTab: (panelId: string, tabId: string) => void;

  // Voice-tab sync
  closeVoiceTabs: (channelId: string) => void;

  // Permission-based tab cleanup (text channels only)
  closeTextTabByChannel: (channelId: string) => void;

  // Close all tabs that belong to a given server (on leave / kick / delete)
  closeTabsForServer: (serverId: string) => void;

  // Split actions
  splitPanel: (panelId: string, direction: SplitDirection, tabId: string, position?: "before" | "after", fromPanelId?: string) => void;
  moveTab: (fromPanelId: string, toPanelId: string, tabId: string) => void;
  setSplitRatio: (path: number[], ratio: number) => void;

  // Panel focus
  setActivePanel: (panelId: string) => void;

  // Members
  toggleMembers: () => void;

  closeDMTab: (channelId: string) => void;

  // Tab label sync (WS channel_update)
  updateTabLabel: (channelId: string, newLabel: string) => void;

  // Quick Switcher (Ctrl+K)
  toggleQuickSwitcher: () => void;
  closeQuickSwitcher: () => void;
};

// ──────────────────────────────────
// Helpers
// ──────────────────────────────────

let panelIdCounter = 0;
function nextPanelId(): string {
  panelIdCounter += 1;
  return `panel-${panelIdCounter}`;
}

let tabIdCounter = 0;
function nextTabId(): string {
  tabIdCounter += 1;
  return `tab-${tabIdCounter}`;
}

/** Find a channel across all panels (enforces single-open rule). */
function findTabAcrossPanels(
  panels: Record<string, Panel>,
  channelId: string
): { panelId: string; tabId: string } | null {
  for (const [panelId, panel] of Object.entries(panels)) {
    const tab = panel.tabs.find((t) => t.channelId === channelId);
    if (tab) return { panelId, tabId: tab.id };
  }
  return null;
}

/**
 * Trigger voice leave when a voice/screen tab is closed.
 * Called AFTER state update to avoid recursion: tab is already gone
 * when voice leave fires, so closeVoiceTabs becomes a no-op.
 */
function triggerVoiceLeaveIfNeeded(closingTab: Tab | undefined): void {
  if (!closingTab) return;
  if (closingTab.type !== "voice" && closingTab.type !== "screen") return;

  const vs = useVoiceStore.getState();
  if (vs.currentVoiceChannelId === closingTab.channelId && vs._onLeaveCallback) {
    vs._onLeaveCallback();
  }
}

// ──────────────────────────────────
// Default state
// ──────────────────────────────────

const defaultPanelId = nextPanelId();

const defaultPanel: Panel = {
  id: defaultPanelId,
  tabs: [],
  activeTabId: null,
};

// ──────────────────────────────────
// Store
// ──────────────────────────────────

export const useUIStore = create<UIState>((set, get) => ({
  destination: HOME_DESTINATION,
  navigationRevision: 0,
  lastChannelByServer: {},

  navigate(destination, options) {
    const serverScoped = ["text", "audit", "voice", "screen", "server-home"].includes(destination.type);
    let target = destination;
    if (serverScoped) {
      const servers = useServerStore.getState();
      const serverId = destination.serverInfo?.serverId ?? servers.activeServerId;
      const server = servers.servers.find((item) => item.id === serverId);
      if (!server) return;
      const serverInfo = { serverId: server.id, serverName: server.name, serverIconUrl: server.icon_url };
      target = { ...destination, serverInfo };
      if (servers.activeServerId !== server.id) servers.setActiveServer(server.id);
      const tree = useChannelStore.getState().categoriesByServer[server.id];
      if (target.type !== "server-home" && tree && !tree.some((group) => group.channels.some((channel) => channel.id === target.channelId))) {
        target = serverDestination(serverInfo);
      }
      if (target.type === "text" || target.type === "audit") {
        useChannelStore.getState().selectChannel(target.channelId);
      }
    }
    if (target.type === "dm") {
      useDMStore.getState().selectDM(target.channelId);
      useDMStore.getState().clearDMUnread(target.channelId);
    } else {
      useDMStore.getState().selectDM(null);
    }
    if (target.type !== "text" && target.type !== "audit") useChannelStore.getState().selectChannel(null);
    set((state) => ({
      destination: target,
      navigationRevision: state.navigationRevision + 1,
      lastChannelByServer: target.serverInfo && (target.type === "text" || target.type === "audit")
        ? { ...state.lastChannelByServer, [target.serverInfo.serverId]: target }
        : state.lastChannelByServer,
    }));
    // Only a deliberately opened text conversation consumes its unread marker.
    if (target.type === "text") {
      const messages = useMessageStore.getState().messagesByChannel[target.channelId];
      if (messages?.length) {
        void useReadStateStore.getState().markAsRead(target.channelId, messages[messages.length - 1].id);
      } else {
        useReadStateStore.getState().clearUnread(target.channelId);
      }
    }
    if (options?.closeDrawers !== false) useMobileStore.getState().closeAllDrawers();
  },

  openServer(serverId) {
    const server = useServerStore.getState().servers.find((item) => item.id === serverId);
    if (!server) return;
    const remembered = get().lastChannelByServer[serverId];
    const cached = useChannelStore.getState().categoriesByServer[serverId];
    const stillVisible = remembered && cached?.some((group) => group.channels.some((channel) => channel.id === remembered.channelId));
    get().navigate(stillVisible ? remembered : serverDestination({ serverId: server.id, serverName: server.name, serverIconUrl: server.icon_url }), { closeDrawers: false });
  },

  closeDestination(channelId) {
    const current = get().destination;
    const remaining = Object.fromEntries(Object.entries(get().lastChannelByServer).filter(([, target]) => target.channelId !== channelId));
    set({ lastChannelByServer: remaining });
    if (current.channelId !== channelId) return;
    get().navigate(current.serverInfo ? serverDestination(current.serverInfo) : HOME_DESTINATION);
  },

  resetNavigation() {
    set((state) => ({ destination: HOME_DESTINATION, navigationRevision: state.navigationRevision + 1, lastChannelByServer: {}, quickSwitcherOpen: false, serverEventsTarget: null }));
  },
  panels: { [defaultPanelId]: defaultPanel },
  layout: { type: "leaf", panelId: defaultPanelId },
  activePanelId: defaultPanelId,
  membersOpen: true,
  quickSwitcherOpen: false,
  serverEventsTarget: null,

  openServerEvents(target) {
    set({ serverEventsTarget: target });
  },

  closeServerEvents() {
    set({ serverEventsTarget: null });
  },

  openTab(channelId, type, label, serverInfo) {
    if (UI_SHELL_V2) {
      get().navigate({ channelId, type, label, serverInfo });
      return;
    }
    const state = get();

    // Channel already open — focus it
    const existing = findTabAcrossPanels(state.panels, channelId);
    if (existing) {
      set({
        activePanelId: existing.panelId,
        panels: {
          ...state.panels,
          [existing.panelId]: {
            ...state.panels[existing.panelId],
            activeTabId: existing.tabId,
          },
        },
      });
      return;
    }

    // Open new tab in active panel
    const panel = state.panels[state.activePanelId];
    if (!panel) return;

    const newTab: Tab = {
      id: nextTabId(),
      channelId,
      type,
      label,
      serverInfo,
    };

    set({
      panels: {
        ...state.panels,
        [panel.id]: {
          ...panel,
          tabs: [...panel.tabs, newTab],
          activeTabId: newTab.id,
        },
      },
    });
  },

  closeTab(panelId, tabId) {
    const state = get();
    const panel = state.panels[panelId];
    if (!panel) return;

    // Save closing tab info for voice/screen sync
    const closingTab = panel.tabs.find((t) => t.id === tabId);

    const newTabs = panel.tabs.filter((t) => t.id !== tabId);

    // Last tab closed — remove panel
    if (newTabs.length === 0) {
      // Keep the last panel alive (empty)
      const panelCount = Object.keys(state.panels).length;
      if (panelCount <= 1) {
        set({
          panels: {
            [panelId]: { ...panel, tabs: [], activeTabId: null },
          },
        });
        // Voice leave after state update
        triggerVoiceLeaveIfNeeded(closingTab);
        return;
      }

      // Remove panel from layout
      const newLayout = removeLeafFromLayout(state.layout, panelId);
      const newPanels = { ...state.panels };
      delete newPanels[panelId];

      // Switch to first remaining panel if active was removed
      const newActivePanelId =
        state.activePanelId === panelId
          ? Object.keys(newPanels)[0]
          : state.activePanelId;

      set({
        panels: newPanels,
        layout: newLayout ?? { type: "leaf", panelId: newActivePanelId },
        activePanelId: newActivePanelId,
      });
      // Trigger voice leave after state update
      triggerVoiceLeaveIfNeeded(closingTab);
      return;
    }

    // Other tabs remain — update active tab
    const newActiveTabId =
      panel.activeTabId === tabId
        ? newTabs[Math.max(0, newTabs.findIndex((t) => t.id === tabId) - 1)]?.id ?? newTabs[0]?.id ?? null
        : panel.activeTabId;

    set({
      panels: {
        ...state.panels,
        [panelId]: {
          ...panel,
          tabs: newTabs,
          activeTabId: newActiveTabId,
        },
      },
    });
    // Voice leave after state update
    triggerVoiceLeaveIfNeeded(closingTab);
  },

  closeVoiceTabs(channelId) {
    if (UI_SHELL_V2) {
      const current = get().destination;
      if (current.channelId === channelId && (current.type === "voice" || current.type === "screen")) get().closeDestination(channelId);
      return;
    }
    // Close voice/screen tabs after voice leave. No recursion risk:
    // currentVoiceChannelId is already null, so triggerVoiceLeaveIfNeeded is a no-op.
    const state = get();

    // Find all voice/screen tabs across panels
    const tabsToClose: { panelId: string; tabId: string }[] = [];
    for (const [pId, panel] of Object.entries(state.panels)) {
      for (const tab of panel.tabs) {
        if (
          (tab.type === "voice" || tab.type === "screen") &&
          tab.channelId === channelId
        ) {
          tabsToClose.push({ panelId: pId, tabId: tab.id });
        }
      }
    }

    // Close each (state updates per call)
    for (const { panelId: pId, tabId: tId } of tabsToClose) {
      get().closeTab(pId, tId);
    }
  },

  setActiveTab(panelId, tabId) {
    const state = get();
    const panel = state.panels[panelId];
    if (!panel) return;

    set({
      activePanelId: panelId,
      panels: {
        ...state.panels,
        [panelId]: { ...panel, activeTabId: tabId },
      },
    });

    // Mark-as-read when switching to a text tab — sidebar-selection isn't the
    // only path into a channel; tab-switching needs to clear the unread badge too.
    const tab = panel.tabs.find((t) => t.id === tabId);
    if (tab && tab.type === "text") {
      const messages = useMessageStore.getState().messagesByChannel[tab.channelId];
      if (messages && messages.length > 0) {
        useReadStateStore.getState().markAsRead(tab.channelId, messages[messages.length - 1].id);
      } else {
        useReadStateStore.getState().clearUnread(tab.channelId);
      }
    }
  },

  splitPanel(panelId, direction, tabId, position = "after", fromPanelId?) {
    const state = get();
    const targetPanel = state.panels[panelId];
    if (!targetPanel) return;

    // Tab can come from target panel (same-panel split) or another panel (cross-panel)
    const actualFromId = fromPanelId ?? panelId;
    const fromPanel = state.panels[actualFromId];
    if (!fromPanel) return;

    const tab = fromPanel.tabs.find((t) => t.id === tabId);
    if (!tab) return;

    // Remove tab from source panel
    const remainingTabs = fromPanel.tabs.filter((t) => t.id !== tabId);
    const fromActiveTabId =
      fromPanel.activeTabId === tabId
        ? remainingTabs[0]?.id ?? null
        : fromPanel.activeTabId;

    // Create new panel for the dragged tab
    const newPanelId = nextPanelId();
    const newPanel: Panel = {
      id: newPanelId,
      tabs: [tab],
      activeTabId: tab.id,
    };

    const newPanels = { ...state.panels };
    let newLayout = insertSplit(state.layout, panelId, newPanelId, direction, position);

    // Source panel: remove tab (or remove entire panel if empty)
    if (remainingTabs.length === 0 && actualFromId !== panelId) {
      // Source panel becomes empty — remove it from layout
      delete newPanels[actualFromId];
      newLayout = removeLeafFromLayout(newLayout, actualFromId) ?? newLayout;
    } else {
      newPanels[actualFromId] = {
        ...fromPanel,
        tabs: remainingTabs,
        activeTabId: fromActiveTabId,
      };
    }

    newPanels[newPanelId] = newPanel;

    set({
      panels: newPanels,
      layout: newLayout,
      activePanelId: newPanelId,
    });
  },

  moveTab(fromPanelId, toPanelId, tabId) {
    const state = get();
    const fromPanel = state.panels[fromPanelId];
    const toPanel = state.panels[toPanelId];
    if (!fromPanel || !toPanel) return;

    const tab = fromPanel.tabs.find((t) => t.id === tabId);
    if (!tab) return;

    // Remove from source panel
    const fromTabs = fromPanel.tabs.filter((t) => t.id !== tabId);
    const fromActiveTabId =
      fromPanel.activeTabId === tabId
        ? fromTabs[0]?.id ?? null
        : fromPanel.activeTabId;

    const newPanels = { ...state.panels };

    // Source panel empty — remove it
    if (fromTabs.length === 0 && Object.keys(newPanels).length > 1) {
      const newLayout = removeLeafFromLayout(state.layout, fromPanelId);
      delete newPanels[fromPanelId];
      newPanels[toPanelId] = {
        ...toPanel,
        tabs: [...toPanel.tabs, tab],
        activeTabId: tab.id,
      };

      set({
        panels: newPanels,
        layout: newLayout ?? { type: "leaf", panelId: toPanelId },
        activePanelId: toPanelId,
      });
      return;
    }

    // Normal move
    newPanels[fromPanelId] = {
      ...fromPanel,
      tabs: fromTabs,
      activeTabId: fromActiveTabId,
    };
    newPanels[toPanelId] = {
      ...toPanel,
      tabs: [...toPanel.tabs, tab],
      activeTabId: tab.id,
    };

    set({
      panels: newPanels,
      activePanelId: toPanelId,
    });
  },

  setSplitRatio(path, ratio) {
    const clamped = Math.max(0.15, Math.min(0.85, ratio));
    set((state) => ({
      layout: updateRatioAtPath(state.layout, path, clamped),
    }));
  },

  setActivePanel(panelId) {
    set({ activePanelId: panelId });
  },

  toggleMembers() {
    set((state) => ({ membersOpen: !state.membersOpen }));
  },

  updateTabLabel(channelId, newLabel) {
    if (get().destination.channelId === channelId) set({ destination: { ...get().destination, label: newLabel } });
    const state = get();
    let changed = false;
    const newPanels = { ...state.panels };

    for (const [panelId, panel] of Object.entries(newPanels)) {
      const idx = panel.tabs.findIndex((t) => t.channelId === channelId);
      if (idx !== -1 && panel.tabs[idx].label !== newLabel) {
        const newTabs = [...panel.tabs];
        newTabs[idx] = { ...newTabs[idx], label: newLabel };
        newPanels[panelId] = { ...panel, tabs: newTabs };
        changed = true;
      }
    }

    if (changed) set({ panels: newPanels });
  },

  toggleQuickSwitcher() {
    set((state) => ({ quickSwitcherOpen: !state.quickSwitcherOpen }));
  },

  closeQuickSwitcher() {
    set({ quickSwitcherOpen: false });
  },

  closeTextTabByChannel(channelId) {
    if (UI_SHELL_V2) {
      get().closeDestination(channelId);
      return;
    }
    const state = get();
    const found = findTabAcrossPanels(state.panels, channelId);
    if (!found) return;

    const panel = state.panels[found.panelId];
    const tab = panel.tabs.find((t) => t.id === found.tabId);
    // Only close text tabs — voice tabs stay open (user may still be in voice)
    if (!tab || tab.type !== "text") return;

    get().closeTab(found.panelId, found.tabId);
  },

  closeDMTab(channelId: string) {
    if (UI_SHELL_V2) {
      if (get().destination.type === "dm") get().closeDestination(channelId);
      return;
    }
    const state = get();
    const found = findTabAcrossPanels(state.panels, channelId);
    if (!found) return;

    const panel = state.panels[found.panelId];
    const tab = panel.tabs.find((t) => t.id === found.tabId);
    if (!tab || tab.type !== "dm") return;

    get().closeTab(found.panelId, found.tabId);
  },

  closeTabsForServer(serverId: string) {
    const remembered = { ...get().lastChannelByServer };
    delete remembered[serverId];
    set({ lastChannelByServer: remembered });
    if (UI_SHELL_V2) {
      if (get().destination.serverInfo?.serverId === serverId) get().navigate(HOME_DESTINATION);
      return;
    }
    // Collect every tab scoped to this server first, then close them one-by-one.
    // closeTab mutates the panel state, so we cannot iterate and close inline.
    const state = get();
    const tabsToClose: { panelId: string; tabId: string }[] = [];
    for (const [pId, panel] of Object.entries(state.panels)) {
      for (const tab of panel.tabs) {
        if (tab.serverInfo?.serverId === serverId) {
          tabsToClose.push({ panelId: pId, tabId: tab.id });
        }
      }
    }
    for (const { panelId, tabId } of tabsToClose) {
      get().closeTab(panelId, tabId);
    }
  },
}));
