import type { MessageAction } from "../components/chat/messageActionRegistry";
import { resolveMessageShortcut, type ShortcutBindings } from "./shortcutRegistry";

/** Reuses the permission-filtered action list; never bypasses confirmation. */
export function runMessageShortcut(event: KeyboardEvent, actions: MessageAction[], hidden: boolean, bindings: ShortcutBindings, focusComposer?: () => boolean): boolean {
  const id = resolveMessageShortcut(event, bindings);
  if (id === "focus-composer" && focusComposer?.()) { event.preventDefault(); event.stopPropagation(); return true; }
  if (!id || hidden) return false;
  const action = actions.find((item) => item.id === id && !item.disabled);
  if (!action) return false;
  event.preventDefault(); event.stopPropagation(); action.run(); return true;
}

export function focusMessageComposer(row: HTMLElement): boolean {
  const composer = row.closest(".chat-area, .group-dm-chat")?.querySelector<HTMLTextAreaElement>(".input-area textarea:not([disabled]), .group-dm-composer textarea:not([disabled])");
  if (!composer) return false;
  composer.focus();
  return document.activeElement === composer;
}
