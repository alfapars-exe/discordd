/**
 * useKeyboardShortcuts — Global keyboard shortcuts hook.
 *
 * Shortcuts:
 * - Ctrl+K — Quick Switcher toggle (works even in input focus, like Discord)
 * - Ctrl+Shift+M — Mute toggle (not in input)
 * - Ctrl+Shift+D — Deafen toggle (not in input)
 * - Configurable mute hotkey (default KeyL, opt-in via Voice Settings) —
 *   toggles mute. Two scopes, chosen by the `muteHotkeyGlobal` setting:
 *     - Electron + muteHotkeyGlobal on: registered as a global uIOhook
 *       shortcut (electron/push-to-talk.ts registerMuteHotkey) that fires
 *       even while the HiChat window is unfocused.
 *     - Otherwise (web, or Electron with muteHotkeyGlobal off): the
 *       document-level listener below — only fires while the app window is
 *       focused. This is also the automatic fallback if global
 *       registration reports failure (e.g. a key not in
 *       push-to-talk.ts's codeToUiohook map).
 *   Loses to the active PTT key on collision in both scopes.
 *
 * Singleton — called once in AppLayout.
 * Uses a bubble-phase document listener (not capture) for app-wide reach.
 */

import { useEffect, useRef, useState } from "react";
import { useUIStore } from "../stores/uiStore";
import { useVoiceStore } from "../stores/voiceStore";
import { isElectron } from "../utils/constants";
import { resolveContextShortcutId, resolveDefaultShortcut, type VoiceShortcutId } from "../utils/shortcutRegistry";
import { useShortcutCaptureStore } from "../stores/shortcutCaptureStore";
import { useShortcutBindingsStore } from "../stores/shortcutBindingsStore";
import { openFocusedContextMenu } from "../utils/contextMenuShortcut";
import type { NavigationShortcutId } from "../utils/shortcutNavigation";
import type { ConversationShortcutId } from "../utils/conversationCommands";
import { hasShortcutModalBoundary } from "../utils/shortcutModalBoundary";

type KeyboardShortcutActions = {
  toggleMute: () => void;
  toggleDeafen: () => void;
  navigate?: (command: NavigationShortcutId) => void;
  conversation?: (command: ConversationShortcutId, event?: KeyboardEvent) => void | boolean;
  inbox?: (command: "inbox-read-top", event: KeyboardEvent) => boolean;
  voice?: (command: VoiceShortcutId, event: KeyboardEvent) => boolean;
};

/** Elements that should swallow the mute hotkey to avoid stealing keystrokes while typing. */
function isTextInput(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (el as HTMLElement).isContentEditable;
}

export function useKeyboardShortcuts({ toggleMute, toggleDeafen, navigate, conversation, inbox, voice }: KeyboardShortcutActions) {
  const [shortcutHelpOpen, setShortcutHelpOpen] = useState(false);
  const capturing = useShortcutCaptureStore((state) => state.active);
  // Read via a ref inside both effects below — useVoice.ts's toggleMute
  // useCallback identity is unstable across renders, and putting it in the
  // registration effect's deps would re-register the Electron global
  // shortcut (and its async IPC round-trip) on every render.
  const toggleMuteRef = useRef(toggleMute);
  useEffect(() => {
    toggleMuteRef.current = toggleMute;
  }, [toggleMute]);

  // True while the Electron global mute hotkey is registered and expected
  // to be live for the current settings. The document-level listener below
  // checks this to yield to the global path instead of double-firing.
  const globalMuteActiveRef = useRef(false);

  const muteHotkeyEnabled = useVoiceStore((s) => s.muteHotkeyEnabled);
  const muteHotkeyGlobal = useVoiceStore((s) => s.muteHotkeyGlobal);
  const muteHotkey = useVoiceStore((s) => s.muteHotkey);
  const inputMode = useVoiceStore((s) => s.inputMode);
  const pttKey = useVoiceStore((s) => s.pttKey);

  // ─── Electron global mute hotkey (works even when the window is unfocused) ───
  useEffect(() => {
    const collidesWithPTT = inputMode === "push_to_talk" && muteHotkey === pttKey;
    const api = window.electronAPI;
    const canRegister =
      isElectron() &&
      api?.registerMuteHotkeyShortcut !== undefined &&
      muteHotkeyEnabled &&
      muteHotkeyGlobal &&
      !capturing &&
      !collidesWithPTT;

    if (!canRegister || !api) {
      globalMuteActiveRef.current = false;
      return;
    }
    let disposed = false;

    api.removeMuteHotkeyListeners?.();
    api.onMuteHotkeyGlobal?.(() => {
      if (disposed || useShortcutCaptureStore.getState().active) return;
      // The global hook fired regardless of window focus. Still don't steal
      // keystrokes from a focused text input while the window IS focused —
      // document.hasFocus() (not activeElement) is what actually tells us
      // the window lost focus, since a blurred window's activeElement stays
      // whatever was last focused (e.g. the message box after alt-tab).
      if (document.hasFocus() && isTextInput(document.activeElement)) return;
      toggleMuteRef.current();
    });

    // Optimistic: assume registration succeeds so the document-level
    // fallback below yields immediately instead of racing the async IPC
    // round-trip and double-firing on the first press.
    globalMuteActiveRef.current = true;
    api.registerMuteHotkeyShortcut?.(muteHotkey)
      .then((ok) => {
        if (disposed) return;
        // Unmapped key (not in push-to-talk.ts's codeToUiohook) — fall back
        // to the document-focused path instead of leaving a dead shortcut.
        if (!ok) globalMuteActiveRef.current = false;
      })
      .catch(() => {
        // IPC failure (main process channel error, etc.) — same fallback as
        // an explicit `false` result. Without this, a rejection leaves the
        // ref stuck optimistically true (the document-level fallback stays
        // suppressed forever) AND surfaces as an unhandled rejection.
        if (!disposed) globalMuteActiveRef.current = false;
      });

    return () => {
      disposed = true;
      api.unregisterMuteHotkeyShortcut?.();
      api.removeMuteHotkeyListeners?.();
      globalMuteActiveRef.current = false;
    };
  }, [muteHotkeyEnabled, muteHotkeyGlobal, muteHotkey, inputMode, pttKey, capturing]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.defaultPrevented || e.isComposing || e.repeat || useShortcutCaptureStore.getState().active) return;
      const currentBindings = useShortcutBindingsStore.getState().bindings;
      const incomingCommand = resolveContextShortcutId(e, "incoming-call", currentBindings) as VoiceShortcutId | undefined;
      if (incomingCommand && voice?.(incomingCommand, e)) { e.preventDefault(); return; }
      const inboxCommand = resolveContextShortcutId(e, "inbox", currentBindings);
      if (inboxCommand === "inbox-read-top" && inbox?.(inboxCommand, e)) { e.preventDefault(); return; }
      const voiceCommand = resolveContextShortcutId(e, "voice", currentBindings) as VoiceShortcutId | undefined;
      if (voiceCommand && voice?.(voiceCommand, e)) { e.preventDefault(); return; }
      const isInputFocused = isTextInput(e.target as HTMLElement);
      const voiceState = useVoiceStore.getState();
      // Device voice bindings may change after a custom assignment was saved.
      // Native hooks match the physical code, regardless of modifier keys.
      if ((voiceState.inputMode === "push_to_talk" && e.code === voiceState.pttKey) ||
          (globalMuteActiveRef.current && e.code === voiceState.muteHotkey)) return;
      const command = resolveDefaultShortcut(e, isInputFocused, currentBindings);
      const openDialog = document.querySelector("dialog[open]");
      const togglesOpenHelp = (command === "app-help" || command === "shortcut-help") && !!openDialog?.querySelector("#shortcut-help-title");
      const blockingOverlay = hasShortcutModalBoundary();
      // A dialog owns its keys. Do not navigate, mark background messages read,
      // or open a second picker behind it. Help can toggle its own dialog and
      // explicit mute/deafen controls remain available independently of chat.
      if (blockingOverlay && !togglesOpenHelp && command
        && command !== "toggle-mute" && command !== "toggle-deafen") return;
      if ((command === "chat-oldest-unread" || command === "chat-page-up" || command === "chat-page-down") && (isInputFocused || isTextInput(document.activeElement) || window.getSelection()?.isCollapsed === false)) return;
      if ((command === "chat-search" || command === "chat-pins" || command === "chat-members" || command === "chat-emoji" || command === "chat-gif" || command === "chat-sticker" || command === "chat-upload" || command === "chat-mark-channel-read" || command === "chat-mark-server-read" || command === "chat-copy-channel-link" || command === "chat-open-inbox" || command === "chat-create-group" || command === "chat-oldest-unread" || command === "chat-page-up" || command === "chat-page-down") && conversation) {
        if ((command === "chat-mark-channel-read" || command === "chat-mark-server-read") &&
            ((e.target instanceof Element && e.target.closest('[role="article"]')) || document.querySelector("dialog[open], .settings-overlay, .modal-backdrop, .report-overlay"))) return;
        if (command === "chat-page-up" || command === "chat-page-down") {
          if (conversation(command, e) === true) e.preventDefault();
          return;
        }
        e.preventDefault(); conversation(command as ConversationShortcutId); return;
      }
      if (command && (command === "previous-server" || command === "next-server" || command === "previous-channel" || command === "next-channel" || command === "previous-unread-channel" || command === "next-unread-channel" || command === "previous-mention-channel" || command === "next-mention-channel" || command === "history-back" || command === "history-forward" || command === "return-to-call" || command === "add-server" || command === "previous-destination") && navigate) {
        e.preventDefault(); navigate(command); return;
      }
      if (command === "context-menu" && openFocusedContextMenu()) { e.preventDefault(); return; }
      if (command === "shortcut-help" || command === "app-help") {
        e.preventDefault();
        setShortcutHelpOpen((open) => !open);
        return;
      }

      // Ctrl+K — Quick Switcher (works in input too)
      if (command === "quick-switcher") {
        e.preventDefault();
        useUIStore.getState().toggleQuickSwitcher();
        return;
      }

      if (isInputFocused) return;

      // Ctrl+Shift+M — Mute toggle
      if (command === "toggle-mute") {
        e.preventDefault();
        toggleMuteRef.current();
        return;
      }

      // Ctrl+Shift+D — Deafen toggle
      if (command === "toggle-deafen") {
        e.preventDefault();
        toggleDeafen();
        return;
      }

      // Electron global mute hotkey is live — it already handles this key
      // (or will, once the OS delivers it) via IPC. Yield instead of
      // double-firing. Never true on web or with the global scope off.
      if (globalMuteActiveRef.current) return;

      // Configurable mute hotkey (opt-in, default KeyL) — read settings
      // fresh on each keydown instead of subscribing, so this effect
      // doesn't need to re-run when the user changes the binding.
      const { muteHotkeyEnabled, muteHotkey, inputMode, pttKey } = useVoiceStore.getState();
      const collidesWithPTT = inputMode === "push_to_talk" && muteHotkey === pttKey;
      if (
        muteHotkeyEnabled &&
        !e.repeat &&
        !e.ctrlKey &&
        !e.shiftKey &&
        !e.altKey &&
        !e.metaKey &&
        e.code === muteHotkey &&
        !collidesWithPTT
      ) {
        e.preventDefault();
        toggleMuteRef.current();
        return;
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [toggleDeafen, navigate, conversation, inbox, voice]);
  return { shortcutHelpOpen, closeShortcutHelp: () => setShortcutHelpOpen(false) };
}
