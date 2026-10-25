import { useEffect, useRef } from "react";
import type { VoiceShortcutId } from "../utils/shortcutRegistry";
import { useShortcutCaptureStore } from "../stores/shortcutCaptureStore";

type VoiceShortcutActionEventDetail = {
  command: VoiceShortcutId;
  sourceEvent: KeyboardEvent;
  handled: boolean;
};

const EVENT_NAME = "hichat:voice-shortcut-action";

function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const element = target.closest("input, textarea, select, [contenteditable='true'], [role='textbox']");
  return element !== null;
}

/** Modal/capture/input handling always gets priority over component shortcuts. */
export function canHandleVoiceShortcut(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.repeat || event.isComposing || useShortcutCaptureStore.getState().active) return false;
  if (isTextEntry(event.target) || isTextEntry(document.activeElement)) return false;
  if (document.querySelector("dialog[open], [role='dialog'], .settings-overlay, .modal-backdrop, .report-overlay")) return false;
  return true;
}

/** Dispatch from the app-wide registry; returns true only if a live surface handled it. */
export function executeVoiceShortcut(command: VoiceShortcutId, sourceEvent: KeyboardEvent): boolean {
  if (typeof window === "undefined") return false;
  const detail: VoiceShortcutActionEventDetail = { command, sourceEvent, handled: false };
  window.dispatchEvent(new CustomEvent<VoiceShortcutActionEventDetail>(EVENT_NAME, { detail }));
  return detail.handled;
}

/** Register a context-local action without teaching the global registry about component state. */
export function useVoiceShortcutAction(command: VoiceShortcutId, action: (event: KeyboardEvent) => boolean): void {
  const actionRef = useRef(action);
  useEffect(() => { actionRef.current = action; }, [action]);

  useEffect(() => {
    const onAction = (event: Event) => {
      const detail = (event as CustomEvent<VoiceShortcutActionEventDetail>).detail;
      if (!detail || detail.command !== command || detail.handled || !canHandleVoiceShortcut(detail.sourceEvent)) return;
      if (actionRef.current(detail.sourceEvent)) detail.handled = true;
    };
    window.addEventListener(EVENT_NAME, onAction);
    return () => window.removeEventListener(EVENT_NAME, onAction);
  }, [command]);
}
