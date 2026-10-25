import { useEffect, useRef, type RefObject } from "react";
import { getAuthGeneration } from "../api/client";
import { useAuthStore } from "../stores/authStore";
import { useShortcutCaptureStore } from "../stores/shortcutCaptureStore";
import { useUIStore } from "../stores/uiStore";

export type FocusComposerTarget = { kind: "channel" | "dm" | "group"; id: string; serverId?: string };

function isInteractiveElement(element: Element | null): boolean {
  if (!element || typeof element.closest !== "function") return false;
  return Boolean(element.closest(
    'input, textarea, select, option, button, a[href], summary, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"], [role="button"], [role="menuitem"], [tabindex]',
  ));
}

function isAllowedBackgroundFocus(element: Element | null): boolean {
  return element === document.body || element === document.documentElement || Boolean(
    element?.matches(".messages-scroll, .group-dm-messages, [data-message-background]"),
  );
}

function matchesDestination(target: FocusComposerTarget): boolean {
  const destination = useUIStore.getState().destination;
  if (target.kind === "channel") {
    return Boolean(target.serverId) && (destination.type === "text" || destination.type === "audit" || destination.type === "voice") &&
      destination.channelId === target.id && destination.serverInfo?.serverId === target.serverId;
  }
  if (target.kind === "dm") return destination.type === "dm" && destination.channelId === target.id;
  return destination.type === "group-dm" && destination.channelId === target.id;
}

function isVisibleComposer(textarea: HTMLTextAreaElement): boolean {
  if (!textarea.isConnected || textarea.disabled || textarea.readOnly || textarea.closest("[hidden], [aria-hidden='true']")) return false;
  const style = window.getComputedStyle(textarea);
  return style.display !== "none" && style.visibility !== "hidden" && style.visibility !== "collapse" && style.opacity !== "0" &&
    textarea.clientHeight > 0 && textarea.getClientRects().length > 0;
}

/** Focus the active chat composer on first typing, but never steal an existing input context. */
export function useFocusComposerOnTyping(
  target: FocusComposerTarget,
  textareaRef: RefObject<HTMLTextAreaElement | null>,
  insert: (key: string) => boolean,
  enabled: boolean,
): void {
  const expectedUserId = useRef(useAuthStore.getState().user?.id);
  const expectedAuthGeneration = useRef(getAuthGeneration());
  const targetKind = target.kind;
  const targetId = target.id;
  const targetServerId = target.serverId;

  useEffect(() => {
    if (!enabled) return;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.repeat || event.isComposing || event.key.length !== 1) return;
      if (event.ctrlKey || event.altKey || event.metaKey || useShortcutCaptureStore.getState().active) return;
      if (window.getSelection()?.isCollapsed === false) return;
      if (document.querySelector('dialog[open], [role="dialog"], [aria-modal="true"], [role="menu"], [role="listbox"], .modal-backdrop, .settings-overlay, .quick-switcher-overlay')) return;

      const activeElement = document.activeElement;
      if (isInteractiveElement(event.target as Element | null) || isInteractiveElement(activeElement)) return;
      if (!isAllowedBackgroundFocus(activeElement)) return;

      const ownerId = expectedUserId.current;
      if (!ownerId || useAuthStore.getState().user?.id !== ownerId || getAuthGeneration() !== expectedAuthGeneration.current) return;
      const activeTarget: FocusComposerTarget = { kind: targetKind, id: targetId, serverId: targetServerId };
      if (!matchesDestination(activeTarget)) return;

      const textarea = textareaRef.current;
      if (!textarea || !isVisibleComposer(textarea)) return;
      if (insert(event.key) !== true) return;
      event.preventDefault();
      textarea.focus();
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [enabled, insert, targetKind, targetId, targetServerId, textareaRef]);
}
