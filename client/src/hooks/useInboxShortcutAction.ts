import { useEffect, useRef } from "react";
import { useShortcutCaptureStore } from "../stores/shortcutCaptureStore";

export type InboxShortcutId = "inbox-read-top";

type InboxShortcutEventDetail = {
  command: InboxShortcutId;
  sourceEvent: KeyboardEvent;
  handled: boolean;
};

const EVENT_NAME = "hichat:inbox-shortcut-action";

function isTextEntry(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='textbox']") !== null;
}

export function canHandleInboxShortcut(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.repeat || event.isComposing || useShortcutCaptureStore.getState().active) return false;
  if (isTextEntry(event.target) || isTextEntry(document.activeElement)) return false;
  if (document.querySelector("dialog[open], [role='dialog'], [aria-modal='true'], .modal-backdrop, .report-overlay, .settings-overlay, [role='menu']")) return false;
  return true;
}

/** Dispatch from AppLayout's shared registry callback; report only live handlers. */
export function executeInboxShortcut(command: InboxShortcutId, sourceEvent: KeyboardEvent): boolean {
  if (typeof window === "undefined") return false;
  const detail: InboxShortcutEventDetail = { command, sourceEvent, handled: false };
  window.dispatchEvent(new CustomEvent<InboxShortcutEventDetail>(EVENT_NAME, { detail }));
  return detail.handled;
}

/** Register a surface-local Inbox action while preserving modal/input precedence. */
export function useInboxShortcutAction(command: InboxShortcutId, action: (event: KeyboardEvent) => boolean): void {
  const actionRef = useRef(action);
  useEffect(() => { actionRef.current = action; }, [action]);
  useEffect(() => {
    const onAction = (event: Event) => {
      const detail = (event as CustomEvent<InboxShortcutEventDetail>).detail;
      if (!detail || detail.command !== command || detail.handled || !canHandleInboxShortcut(detail.sourceEvent)) return;
      if (actionRef.current(detail.sourceEvent)) detail.handled = true;
    };
    window.addEventListener(EVENT_NAME, onAction);
    return () => window.removeEventListener(EVENT_NAME, onAction);
  }, [command]);
}
