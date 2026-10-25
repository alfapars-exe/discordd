import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { useConfirm } from "./useConfirm";
import type { SettingsTab } from "../stores/settingsStore";
import type { SettingsSection, SettingsWorkspace } from "../components/settings/settingsWorkspaceContext";

type Options = {
  isOpen: boolean;
  scope: string;
  activeTab: SettingsTab;
  allowedTabs: SettingsTab[];
  setActiveTab: (tab: SettingsTab) => void;
  closeSettings: () => void;
};
type Position = { top: number; section: string | null };
type SectionState = { key: string; sections: SettingsSection[]; active: string | null };

function revealSection(heading: HTMLElement) {
  // A section link must reveal its controls, not merely focus a closed summary.
  let parent: HTMLElement | null = heading;
  while (parent) {
    if (parent instanceof HTMLDetailsElement) parent.open = true;
    parent = parent.parentElement;
  }
}

/** Modal-session state only: no profile text, credentials or device identifiers. */
export function useSettingsWorkspace(options: Options, contentRef: RefObject<HTMLDivElement | null>): SettingsWorkspace {
  const { isOpen, scope, activeTab, setActiveTab, closeSettings } = options;
  const { t } = useTranslation("settings");
  const confirm = useConfirm();
  const positions = useRef(new Map<string, Position>());
  const drafts = useRef(new Set<string>());
  const confirming = useRef(false);
  const requestedAnchor = useRef<{ key: string; id: string } | null>(null);
  const latest = useRef(options);
  const key = `${scope}:${activeTab}`;
  const [sectionState, setSections] = useState<SectionState>({ key: "", sections: [], active: null });
  const [history, setHistory] = useState<{ scope: string; tabs: SettingsTab[] }>({ scope: "", tabs: [] });
  useLayoutEffect(() => { latest.current = options; });

  const remember = useCallback(() => {
    const root = contentRef.current;
    if (!root) return;
    const current = latest.current;
    const currentKey = `${current.scope}:${current.activeTab}`;
    const previous = positions.current.get(currentKey);
    positions.current.set(currentKey, { top: root.scrollTop, section: previous?.section ?? null });
    if (positions.current.size > 128) positions.current.delete(positions.current.keys().next().value!);
  }, [contentRef]);

  const registerDraft = useCallback((id: string, dirty: boolean) => {
    if (dirty) drafts.current.add(id);
    else drafts.current.delete(id);
  }, []);

  const guarded = useCallback(async (action: () => void) => {
    if (confirming.current) return;
    const start = latest.current;
    if (!start.isOpen) return;
    if (drafts.current.size) {
      confirming.current = true;
      try {
        const discard = await confirm({
          title: t("workspace.unsavedTitle"), message: t("workspace.unsavedMessage"),
          confirmLabel: t("workspace.discard"), cancelLabel: t("workspace.keepEditing"), danger: true,
        });
        if (!discard) return;
      } finally { confirming.current = false; }
    }
    const current = latest.current;
    // An answer to an old dialog must never navigate a different account/server.
    if (!current.isOpen || current.scope !== start.scope || current.activeTab !== start.activeTab) return;
    remember();
    action();
  }, [confirm, remember, t]);

  const navigate = useCallback((tab: SettingsTab, section?: string) => {
    const current = latest.current;
    if (tab === current.activeTab || !current.allowedTabs.includes(tab)) return;
    void guarded(() => {
      if (!latest.current.allowedTabs.includes(tab)) return;
      requestedAnchor.current = section ? { key: `${current.scope}:${tab}`, id: `settings-${tab}-${section}` } : null;
      setHistory((previous) => ({ scope: current.scope, tabs: [...(previous.scope === current.scope ? previous.tabs : []), current.activeTab].slice(-20) }));
      setActiveTab(tab);
    });
  }, [guarded, setActiveTab]);

  const back = useCallback(() => {
    const current = latest.current;
    if (history.scope !== current.scope) return;
    const tabs = history.tabs.filter((tab) => current.allowedTabs.includes(tab));
    const target = tabs.at(-1);
    if (!target) return;
    void guarded(() => {
      if (!latest.current.allowedTabs.includes(target)) return;
      setHistory({ scope: current.scope, tabs: tabs.slice(0, -1) });
      setActiveTab(target);
    });
  }, [guarded, history, setActiveTab]);

  const close = useCallback(() => { void guarded(closeSettings); }, [guarded, closeSettings]);

  const navigateSection = useCallback((id: string) => {
    const root = contentRef.current;
    const heading = root && Array.from(root.querySelectorAll<HTMLElement>("[data-settings-anchor]")).find((node) => node.id === id);
    if (!root || !heading) return;
    revealSection(heading);
    const scale = root.offsetHeight ? root.getBoundingClientRect().height / root.offsetHeight : 1;
    root.scrollTop = Math.max(0, root.scrollTop + (heading.getBoundingClientRect().top - root.getBoundingClientRect().top) / (scale || 1) - 24);
    heading.focus({ preventScroll: true });
    const currentKey = `${latest.current.scope}:${latest.current.activeTab}`;
    positions.current.set(currentKey, { top: root.scrollTop, section: id });
    setSections((previous) => ({ ...previous, active: id }));
  }, [contentRef]);

  useEffect(() => {
    if (!isOpen) return;
    const onUnload = (event: BeforeUnloadEvent) => {
      if (drafts.current.size) { event.preventDefault(); event.returnValue = ""; }
    };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [isOpen]);

  useEffect(() => {
    const root = contentRef.current;
    if (!isOpen || !root) return;
    let restored = false;
    let frame = 0;
    let headings: HTMLElement[] = [];
    const updateActive = () => {
      if (!restored || !headings.length) return;
      const scale = root.offsetHeight ? root.getBoundingClientRect().height / root.offsetHeight : 1;
      const top = root.getBoundingClientRect().top + 28 * (scale || 1);
      let active = headings[0].id;
      for (const heading of headings) if (heading.getBoundingClientRect().top <= top) active = heading.id;
      if (root.scrollHeight > root.clientHeight + 1 && root.scrollTop + root.clientHeight >= root.scrollHeight - 2) active = headings.at(-1)!.id;
      positions.current.set(key, { top: root.scrollTop, section: active });
      setSections((previous) => previous.key === key && previous.active !== active ? { ...previous, active } : previous);
    };
    const collect = () => {
      const panel = root.querySelector<HTMLElement>(`[data-settings-panel="${activeTab}"]`);
      if (!panel) return; // Lazy panels must finish rendering before restoring.
      const candidates = Array.from(panel.querySelectorAll<HTMLElement>("[data-settings-section], h2.settings-section-title, h3.settings-section-subtitle, .vs-section-header"))
        .map((node) => node.matches("h1,h2,h3,h4,h5,h6,summary,[data-settings-label],.vs-section-header") || (node.hasAttribute("data-settings-section") && node.children.length === 0)
          ? node : node.querySelector<HTMLElement>("h1,h2,h3,h4,h5,h6,summary,[data-settings-label],.vs-section-header"))
        .filter((node): node is HTMLElement => node !== null)
        .filter((node, index, nodes) => nodes.indexOf(node) === index)
        .filter((node) => !node.closest("[hidden], [inert], [aria-hidden='true']"));
      // Some panels put data-settings-section on the whole visual section as
      // well as a real header inside it. The container's textContent includes
      // every control/help string, so only keep the most specific candidate.
      headings = candidates.filter((node) => !candidates.some((other) => other !== node && node.contains(other)));
      const sections = headings.map((heading, index) => {
        const section = heading.closest<HTMLElement>("[data-settings-section]");
        const anchor = heading.dataset.settingsSection || section?.dataset.settingsSection || `section-${index}`;
        heading.id = `settings-${activeTab}-${anchor}`;
        heading.dataset.settingsAnchor = "true";
        // Preserve summary's native keyboard/disclosure semantics and expanded
        // state. Replacing its role with heading hides that control from AT.
        if (heading.tagName !== "SUMMARY") {
          heading.tabIndex = -1;
          if (!/^H[1-6]$/.test(heading.tagName)) { heading.setAttribute("role", "heading"); heading.setAttribute("aria-level", "2"); }
        }
        return { id: heading.id, label: heading.dataset.settingsLabel || heading.textContent?.trim() || "" };
      }).filter((section) => section.label);
      if (!restored) {
        const request = requestedAnchor.current;
        const target = request?.key === key ? headings.find((heading) => heading.id === request.id) : undefined;
        if (target) {
          revealSection(target);
          const scale = root.offsetHeight ? root.getBoundingClientRect().height / root.offsetHeight : 1;
          root.scrollTop = Math.max(0, root.scrollTop + (target.getBoundingClientRect().top - root.getBoundingClientRect().top) / (scale || 1) - 24);
          target.focus({ preventScroll: true });
          requestedAnchor.current = null;
        } else root.scrollTop = positions.current.get(key)?.top ?? 0;
        restored = true;
      }
      setSections((previous) => previous.key === key && JSON.stringify(previous.sections) === JSON.stringify(sections)
        ? previous : { key, sections, active: positions.current.get(key)?.section ?? sections[0]?.id ?? null });
      updateActive();
    };
    const queueCollect = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(collect); };
    const observer = new MutationObserver(queueCollect);
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    root.addEventListener("scroll", updateActive, { passive: true });
    window.addEventListener("resize", queueCollect);
    queueCollect();
    return () => {
      cancelAnimationFrame(frame); observer.disconnect();
      root.removeEventListener("scroll", updateActive);
      window.removeEventListener("resize", queueCollect);
    };
  }, [isOpen, activeTab, key, contentRef]);

  return {
    sections: sectionState.key === key ? sectionState.sections : [],
    activeSection: sectionState.key === key ? sectionState.active : null,
    canGoBack: history.scope === scope && history.tabs.some((tab) => options.allowedTabs.includes(tab)),
    navigate, navigateSection, back, close, registerDraft,
  };
}
