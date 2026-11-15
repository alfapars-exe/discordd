/**
 * Sidebar Store — Left sidebar expand/collapse state.
 *
 * Two modes:
 * - Expanded (240px): Full tree view — Header + ChannelTree + UserBar
 * - Collapsed (52px): Server icon + badges only
 *
 * Section keys: "friends", "dms", "server", "cat:{categoryId}"
 * Missing keys default to expanded (true).
 * State is persisted to both localStorage (immediate) and server preferences (durable).
 */

import { create } from "zustand";
import { usePreferencesStore } from "./preferencesStore";
import { capturePreferenceScope } from "./preferenceScope";

const SIDEBAR_STORAGE_KEY = "mqvi_sidebar";

type PersistedSidebar = {
  isExpanded: boolean;
  expandedSections: Record<string, boolean>;
};

function loadPersistedSidebar(): PersistedSidebar {
  try {
    const raw = localStorage.getItem(SIDEBAR_STORAGE_KEY);
    if (raw) {
      // Guard against JSON.parse returning array / primitive / null
      // before treating the result as a partial settings object.
      const parsedRaw: unknown = JSON.parse(raw);
      const parsed: Partial<PersistedSidebar> =
        parsedRaw && typeof parsedRaw === "object" && !Array.isArray(parsedRaw)
          ? (parsedRaw as Partial<PersistedSidebar>)
          : {};
      return {
        isExpanded: typeof parsed.isExpanded === "boolean" ? parsed.isExpanded : true,
        expandedSections:
          parsed.expandedSections && typeof parsed.expandedSections === "object"
            ? parsed.expandedSections
            : { friends: true, dms: true, server: true },
      };
    }
  } catch {
    /* parse error — use defaults */
  }
  return {
    isExpanded: true,
    expandedSections: { friends: true, dms: true, server: true },
  };
}

function persistSidebar(state: PersistedSidebar): void {
  try {
    localStorage.setItem(SIDEBAR_STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* localStorage full or inaccessible */
  }
}

/** Sync sidebar sections to server preferences */
function syncToServer(sections?: Record<string, boolean>, isExpanded?: boolean): void {
  usePreferencesStore.getState().set({
    ...(sections ? { sidebar_sections: sections } : {}),
    ...(typeof isExpanded === "boolean" ? { sidebar_expanded: isExpanded } : {}),
  });
}

// ──────────────────────────────────
// Store types
// ──────────────────────────────────

type SidebarState = {
  /** true = 240px, false = 52px */
  isExpanded: boolean;
  /** Section expand/collapse states. Missing key = expanded (true). */
  expandedSections: Record<string, boolean>;

  // ─── Actions ───
  toggleSidebar: () => void;
  expandSidebar: () => void;
  collapseSidebar: () => void;
  toggleSection: (sectionKey: string) => void;
  expandSection: (sectionKey: string) => void;
  isSectionExpanded: (sectionKey: string) => boolean;
  /** Apply sidebar state from server preferences (no re-sync to server) */
  applyFromServer: (sections: Record<string, boolean>, isExpanded?: boolean) => void;
  resetAccountPreferences: () => void;
};

// ──────────────────────────────────
// Store
// ──────────────────────────────────

const initial = loadPersistedSidebar();

export const useSidebarStore = create<SidebarState>((set, get) => {
  function commit(sections?: Record<string, boolean>, isExpanded?: boolean) {
    const isCurrent = capturePreferenceScope();
    const current = get();
    const next = {
      isExpanded: isExpanded ?? current.isExpanded,
      expandedSections: sections ? { ...current.expandedSections, ...sections } : current.expandedSections,
    };
    // Do not perform cross-store work inside a Zustand updater: preference
    // observers can replace this binding before the updater returns.
    persistSidebar(next);
    set(next);
    if (!isCurrent()) return;
    const latest = get();
    const owned = sections ? Object.fromEntries(Object.entries(sections).filter(([key, value]) => latest.expandedSections[key] === value)) : undefined;
    const expanded = latest.isExpanded === isExpanded ? isExpanded : undefined;
    if (owned && Object.keys(owned).length || expanded !== undefined) syncToServer(owned, expanded);
  }
  return {
    isExpanded: initial.isExpanded,
    expandedSections: initial.expandedSections,
    toggleSidebar: () => commit(undefined, !get().isExpanded),
    expandSidebar: () => { if (!get().isExpanded) commit(undefined, true); },
    collapseSidebar: () => { if (get().isExpanded) commit(undefined, false); },
    toggleSection: sectionKey => commit({ [sectionKey]: !(get().expandedSections[sectionKey] ?? true) }),
    expandSection: sectionKey => { if (!get().expandedSections[sectionKey]) commit({ [sectionKey]: true }); },
    isSectionExpanded: sectionKey => get().expandedSections[sectionKey] ?? true,
    applyFromServer: (sections, isExpanded?: boolean) => {
      const merged = { ...get().expandedSections, ...sections };
      const expanded = typeof isExpanded === "boolean" ? isExpanded : get().isExpanded;
      persistSidebar({ isExpanded: expanded, expandedSections: merged });
      set({ expandedSections: merged, isExpanded: expanded });
    },
    resetAccountPreferences: () => {
      const defaults = { isExpanded: true, expandedSections: { friends: true, dms: true, server: true } };
      persistSidebar(defaults);
      set(defaults);
    },
  };
});
