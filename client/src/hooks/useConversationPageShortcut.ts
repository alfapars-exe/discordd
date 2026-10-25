import { useEffect, type RefObject } from "react";
import { getAuthGeneration } from "../api/client";
import { useAuthStore } from "../stores/authStore";
import { useShortcutCaptureStore } from "../stores/shortcutCaptureStore";
import { useUIStore } from "../stores/uiStore";

export type ConversationPageShortcut = "chat-page-up" | "chat-page-down";
export const CONVERSATION_PAGE_SHORTCUT_EVENT = "hichat:conversation-page-shortcut";

type ConversationPageShortcutDetail = {
  command: ConversationPageShortcut;
  sourceEvent: KeyboardEvent;
  ownerId: string;
  authGeneration: number;
};
export type PageShortcutTarget =
  | { kind: "channel"; id: string; serverId?: string }
  | { kind: "dm"; id: string }
  | { kind: "group"; id: string };

function blockedSurface(sourceEvent: KeyboardEvent): boolean {
  if (sourceEvent.defaultPrevented || sourceEvent.repeat || sourceEvent.isComposing) return true;
  if (document.querySelector(
    "dialog[open], [role='dialog'], [aria-modal='true'], [role='menu'], .settings-overlay, .modal-backdrop, .report-overlay, .new-conversation-overlay, .quick-switcher-overlay, .shortcut-capture-overlay"
  )) return true;
  if (useShortcutCaptureStore.getState().active) return true;
  if (window.getSelection()?.toString()) return true;

  const isTextEntry = (element: Element | null) => element instanceof HTMLElement && (
    element.matches("input, textarea, select") ||
    element.isContentEditable ||
    ["true", "plaintext-only"].includes(element.getAttribute("contenteditable")?.toLowerCase() ?? "") ||
    !!element.closest("[contenteditable='true'], [contenteditable='plaintext-only'], [role='textbox']")
  );
  if (isTextEntry(sourceEvent.target instanceof Element ? sourceEvent.target : null) || isTextEntry(document.activeElement)) return true;
  return false;
}

function targetIsActive(target: PageShortcutTarget): boolean {
  const destination = useUIStore.getState().destination;
  if (target.kind === "group") return destination.type === "group-dm" && destination.channelId === target.id;
  if (target.kind === "dm") return destination.type === "dm" && destination.channelId === target.id;
  return (destination.type === "text" || destination.type === "audit" || destination.type === "voice") &&
    destination.channelId === target.id && destination.serverInfo?.serverId === target.serverId;
}

function isVisibleScrollSurface(element: HTMLElement): boolean {
  if (!element.isConnected || element.clientHeight <= 0) return false;
  if (element.closest("[hidden], [aria-hidden='true']")) return false;
  const style = window.getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden") return false;
  return element.getClientRects().length > 0;
}

/** Scrolls only when the target can move, returning synchronous acknowledgement. */
export function scrollConversationPage(element: HTMLElement, command: ConversationPageShortcut): boolean {
  const before = element.scrollTop;
  const max = Math.max(0, element.scrollHeight - element.clientHeight);
  const overlap = Math.min(90, Math.round(element.clientHeight * 0.1));
  const distance = Math.max(1, element.clientHeight - overlap);
  const next = Math.max(0, Math.min(max, before + (command === "chat-page-up" ? -distance : distance)));
  if (next === before) return false;
  element.scrollTop = next;
  return element.scrollTop !== before;
}

/**
 * Synchronously dispatches a page-scroll request. A matching active surface
 * prevents the cancelable event only after confirming that it actually moved.
 */
export function executeConversationPageShortcut(command: ConversationPageShortcut, sourceEvent: KeyboardEvent): boolean {
  const expectedCode = command === "chat-page-up" ? "PageUp" : "PageDown";
  if (sourceEvent.code !== expectedCode || sourceEvent.ctrlKey || sourceEvent.shiftKey || sourceEvent.altKey || sourceEvent.metaKey) return false;
  if (blockedSurface(sourceEvent)) return false;
  const ownerId = useAuthStore.getState().user?.id;
  if (!ownerId) return false;
  const request = new CustomEvent<ConversationPageShortcutDetail>(CONVERSATION_PAGE_SHORTCUT_EVENT, {
    detail: { command, sourceEvent, ownerId, authGeneration: getAuthGeneration() },
    cancelable: true,
  });
  window.dispatchEvent(request);
  return request.defaultPrevented;
}

export function useConversationPageShortcut(target: PageShortcutTarget, scrollRef: RefObject<HTMLElement | null>): void {
  const ownerId = useAuthStore((state) => state.user?.id ?? null);
  const authGeneration = getAuthGeneration();
  const targetKind = target.kind;
  const targetId = target.id;
  const targetServerId = target.kind === "channel" ? target.serverId : undefined;
  useEffect(() => {
    const targetSnapshot: PageShortcutTarget = targetKind === "channel"
      ? { kind: "channel", id: targetId, serverId: targetServerId }
      : { kind: targetKind, id: targetId };
    const listener = (event: Event) => {
      if (event.defaultPrevented || !(event instanceof CustomEvent)) return;
      const detail = event.detail as ConversationPageShortcutDetail | undefined;
      if (detail?.command !== "chat-page-up" && detail?.command !== "chat-page-down") return;
      if (!(detail.sourceEvent instanceof KeyboardEvent) || blockedSurface(detail.sourceEvent)) return;
      if (!ownerId || detail.ownerId !== ownerId || detail.authGeneration !== authGeneration ||
        detail.ownerId !== useAuthStore.getState().user?.id || detail.authGeneration !== getAuthGeneration()) return;
      const element = scrollRef.current;
      if (!element || !targetIsActive(targetSnapshot) || !isVisibleScrollSurface(element)) return;
      if (scrollConversationPage(element, detail.command)) event.preventDefault();
    };
    window.addEventListener(CONVERSATION_PAGE_SHORTCUT_EVENT, listener);
    return () => window.removeEventListener(CONVERSATION_PAGE_SHORTCUT_EVENT, listener);
  }, [targetKind, targetId, targetServerId, scrollRef, ownerId, authGeneration]);
}
