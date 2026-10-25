/** Runtime bindings and their display metadata share this command source. */
export const shortcutRegistry = [
  { id: "lofi-player", category: "other", code: "KeyW", key: "w", ctrl: true, alt: true, shift: true, allowInInput: false, customizable: false, labelKey: "shortcutLofi" },
  { id: "shortcut-help", category: "other", code: "Slash", key: "/", ctrl: true, shift: false, allowInInput: true, labelKey: "shortcutHelp" },
  { id: "overlay-lock", category: "other", code: "KeyO", key: "o", ctrl: true, alt: true, shift: false, optIn: true, allowInInput: false, labelKey: "shortcutOverlayLock" },
  { id: "app-help", category: "other", code: "KeyH", key: "h", ctrl: true, shift: true, allowInInput: true, customizable: false, labelKey: "shortcutAppHelp" },
  { id: "context-menu", category: "other", code: "F10", key: "F10", ctrl: false, shift: true, allowInInput: true, customizable: false, labelKey: "shortcutContextMenu" },
  { id: "quick-switcher", category: "navigation", code: "KeyK", key: "k", ctrl: true, shift: false, allowInInput: true, labelKey: "shortcutQuickSwitcher" },
  { id: "toggle-mute", category: "voice", code: "KeyM", key: "m", ctrl: true, shift: true, allowInInput: false, labelKey: "shortcutToggleMute" },
  { id: "toggle-deafen", category: "voice", code: "KeyD", key: "d", ctrl: true, shift: true, allowInInput: false, labelKey: "shortcutToggleDeafen" },
  { id: "previous-server", category: "navigation", code: "ArrowUp", key: "ArrowUp", ctrl: true, shift: false, alt: true, allowInInput: true, labelKey: "shortcutPreviousServer" },
  { id: "next-server", category: "navigation", code: "ArrowDown", key: "ArrowDown", ctrl: true, shift: false, alt: true, allowInInput: true, labelKey: "shortcutNextServer" },
  { id: "history-back", category: "navigation", code: "ArrowLeft", key: "ArrowLeft", ctrl: false, shift: false, alt: true, allowInInput: true, customizable: false, labelKey: "shortcutHistoryBack" },
  { id: "history-forward", category: "navigation", code: "ArrowRight", key: "ArrowRight", ctrl: false, shift: false, alt: true, allowInInput: true, customizable: false, labelKey: "shortcutHistoryForward" },
  { id: "return-to-call", category: "voice", code: "KeyV", key: "v", ctrl: true, shift: true, alt: true, allowInInput: true, labelKey: "shortcutReturnToCall" },
  { id: "add-server", category: "navigation", code: "KeyN", key: "n", ctrl: true, shift: true, alt: false, allowInInput: true, customizable: false, labelKey: "shortcutAddServer" },
  { id: "previous-destination", category: "navigation", code: "ArrowRight", key: "ArrowRight", ctrl: true, shift: false, alt: true, allowInInput: true, customizable: false, labelKey: "shortcutPreviousDestination" },
  { id: "previous-channel", category: "navigation", code: "ArrowUp", key: "ArrowUp", ctrl: false, shift: false, alt: true, allowInInput: true, labelKey: "shortcutPreviousChannel" },
  { id: "next-channel", category: "navigation", code: "ArrowDown", key: "ArrowDown", ctrl: false, shift: false, alt: true, allowInInput: true, labelKey: "shortcutNextChannel" },
  { id: "previous-unread-channel", category: "navigation", code: "ArrowUp", key: "ArrowUp", ctrl: false, shift: true, alt: true, allowInInput: true, labelKey: "shortcutPreviousUnreadChannel" },
  { id: "next-unread-channel", category: "navigation", code: "ArrowDown", key: "ArrowDown", ctrl: false, shift: true, alt: true, allowInInput: true, labelKey: "shortcutNextUnreadChannel" },
  { id: "previous-mention-channel", category: "navigation", code: "ArrowUp", key: "ArrowUp", ctrl: true, shift: true, alt: true, allowInInput: true, labelKey: "shortcutPreviousMentionChannel" },
  { id: "next-mention-channel", category: "navigation", code: "ArrowDown", key: "ArrowDown", ctrl: true, shift: true, alt: true, allowInInput: true, labelKey: "shortcutNextMentionChannel" },
  { id: "chat-search", category: "chat", code: "KeyF", key: "f", ctrl: true, shift: false, allowInInput: true, labelKey: "shortcutChatSearch" },
  { id: "chat-pins", category: "chat", code: "KeyP", key: "p", ctrl: true, shift: false, allowInInput: true, labelKey: "shortcutChatPins" },
  { id: "chat-members", category: "chat", code: "KeyU", key: "u", ctrl: true, shift: false, allowInInput: true, labelKey: "shortcutChatMembers" },
  { id: "chat-emoji", category: "chat", code: "KeyE", key: "e", ctrl: true, shift: false, allowInInput: true, labelKey: "shortcutChatEmoji" },
  { id: "chat-gif", category: "chat", code: "KeyG", key: "g", ctrl: true, shift: false, allowInInput: true, labelKey: "shortcutChatGif" },
  { id: "chat-sticker", category: "chat", code: "KeyS", key: "s", ctrl: true, shift: false, allowInInput: true, labelKey: "shortcutChatSticker" },
  { id: "chat-upload", category: "chat", code: "KeyU", key: "u", ctrl: true, shift: true, allowInInput: true, labelKey: "shortcutChatUpload" },
  { id: "chat-open-inbox", category: "chat", code: "KeyI", key: "i", ctrl: true, shift: false, allowInInput: false, customizable: false, labelKey: "shortcutOpenInbox" },
  { id: "chat-create-group", category: "chat", code: "KeyT", key: "t", ctrl: true, shift: true, allowInInput: false, customizable: false, labelKey: "shortcutCreateGroup" },
  { id: "chat-oldest-unread", category: "chat", code: "PageUp", key: "PageUp", ctrl: false, shift: true, alt: false, allowInInput: false, customizable: false, labelKey: "shortcutOldestUnread" },
  { id: "chat-page-up", category: "chat", code: "PageUp", key: "PageUp", ctrl: false, shift: false, alt: false, allowInInput: false, customizable: false, labelKey: "shortcutPageUp" },
  { id: "chat-page-down", category: "chat", code: "PageDown", key: "PageDown", ctrl: false, shift: false, alt: false, allowInInput: false, customizable: false, labelKey: "shortcutPageDown" },
  { id: "inbox-read-top", context: "inbox", actionId: "read-top", category: "inbox", code: "KeyE", key: "e", ctrl: true, shift: true, alt: false, allowInInput: false, customizable: false, labelKey: "shortcutReadTopInbox" },
  { id: "chat-mark-channel-read", category: "chat", code: "Escape", key: "Escape", ctrl: false, shift: false, allowInInput: false, labelKey: "shortcutMarkChannelRead" },
  { id: "chat-mark-server-read", category: "chat", code: "Escape", key: "Escape", ctrl: false, shift: true, allowInInput: false, labelKey: "shortcutMarkServerRead" },
  { id: "chat-copy-channel-link", category: "chat", code: "KeyL", key: "l", ctrl: true, shift: true, allowInInput: true, labelKey: "shortcutCopyChannelLink" },
  { id: "message-edit", context: "message", actionId: "edit", category: "messages", code: "KeyE", key: "e", ctrl: false, shift: false, allowInInput: false, labelKey: "shortcutMessageEdit" },
  { id: "message-delete", context: "message", actionId: "delete", category: "messages", code: "Backspace", key: "Backspace", ctrl: false, shift: false, allowInInput: false, labelKey: "shortcutMessageDelete" },
  { id: "message-pin", context: "message", actionId: "pin", category: "messages", code: "KeyP", key: "p", ctrl: false, shift: false, allowInInput: false, labelKey: "shortcutMessagePin" },
  { id: "message-reaction", context: "message", actionId: "reaction", category: "messages", code: "Equal", key: "+", ctrl: false, shift: true, allowInInput: false, labelKey: "shortcutMessageReaction" },
  { id: "message-reply", context: "message", actionId: "reply", category: "messages", code: "KeyR", key: "r", ctrl: false, shift: false, allowInInput: false, labelKey: "shortcutMessageReply" },
  { id: "message-forward", context: "message", actionId: "forward", category: "messages", code: "KeyF", key: "f", ctrl: false, shift: false, allowInInput: false, labelKey: "shortcutMessageForward" },
  { id: "message-copy", context: "message", actionId: "copy", category: "messages", code: "KeyC", key: "c", ctrl: true, shift: false, allowInInput: false, labelKey: "shortcutMessageCopy" },
  { id: "message-unread", context: "message", actionId: "mark-unread", category: "messages", code: "Enter", key: "Enter", ctrl: false, shift: false, alt: true, allowInInput: false, labelKey: "shortcutMessageUnread" },
  { id: "message-speak", context: "message", actionId: "speak", category: "messages", code: "KeyS", key: "s", ctrl: false, shift: false, allowInInput: false, labelKey: "shortcutMessageSpeak" },
  { id: "message-compose", context: "message", actionId: "focus-composer", category: "messages", code: "Escape", key: "Escape", ctrl: false, shift: false, allowInInput: false, labelKey: "shortcutMessageCompose" },
  { id: "message-thread", context: "message", actionId: "thread", category: "messages", code: "KeyN", key: "n", ctrl: true, shift: true, alt: true, allowInInput: false, labelKey: "shortcutMessageThread" },
  { id: "incoming-call-answer", context: "incoming-call", actionId: "answer", category: "voice", code: "Enter", key: "Enter", ctrl: true, shift: false, alt: false, allowInInput: false, labelKey: "shortcutIncomingCallAnswer" },
  { id: "incoming-call-reject", context: "incoming-call", actionId: "reject", category: "voice", code: "Escape", key: "Escape", ctrl: false, shift: false, alt: false, allowInInput: false, labelKey: "shortcutIncomingCallReject" },
  { id: "group-call-start", context: "voice", actionId: "group-call-start", category: "voice", code: "Quote", key: "'", ctrl: true, shift: false, alt: false, allowInInput: false, labelKey: "shortcutGroupCallStart" },
  { id: "voice-soundboard", context: "voice", actionId: "soundboard", category: "voice", code: "KeyB", key: "b", ctrl: true, shift: true, alt: false, allowInInput: false, labelKey: "shortcutVoiceSoundboard" },
  { id: "drag-start", context: "drag", actionId: "start", category: "navigation", code: "KeyD", key: "d", ctrl: true, shift: false, allowInInput: false, customizable: false, labelKey: "shortcutDragStart" },
  { id: "drag-up", context: "drag", actionId: "up", category: "navigation", code: "ArrowUp", key: "ArrowUp", ctrl: false, shift: false, allowInInput: false, customizable: false, labelKey: "shortcutDragUp" },
  { id: "drag-down", context: "drag", actionId: "down", category: "navigation", code: "ArrowDown", key: "ArrowDown", ctrl: false, shift: false, allowInInput: false, customizable: false, labelKey: "shortcutDragDown" },
  { id: "drag-drop", context: "drag", actionId: "drop", category: "navigation", code: "Enter", key: "Enter", ctrl: false, shift: false, allowInInput: false, customizable: false, labelKey: "shortcutDragDrop" },
  { id: "drag-cancel", context: "drag", actionId: "cancel", category: "navigation", code: "Escape", key: "Escape", ctrl: false, shift: false, allowInInput: false, customizable: false, labelKey: "shortcutDragCancel" },
] as const;

export type ShortcutId = typeof shortcutRegistry[number]["id"];
export type ShortcutContext = "message" | "drag" | "incoming-call" | "voice" | "inbox";
export type VoiceShortcutId = "incoming-call-answer" | "incoming-call-reject" | "group-call-start" | "voice-soundboard";
export type ShortcutBinding = { code: string; key: string; ctrl: boolean; shift: boolean; alt: boolean; meta: boolean };
export type ShortcutBindings = Partial<Record<ShortcutId, ShortcutBinding>> & { disabledCommands?: readonly ShortcutId[] };
export function isShortcutEnabled(id: ShortcutId, bindings: ShortcutBindings): boolean {
  const command = shortcutRegistry.find((item) => item.id === id);
  return !bindings.disabledCommands?.includes(id) && (!(command && "optIn" in command && command.optIn) || !!bindings[id]);
}
export function commandBinding(command: typeof shortcutRegistry[number], bindings: ShortcutBindings): ShortcutBinding {
  return ((!("customizable" in command) || command.customizable) ? bindings[command.id] : undefined) ?? { code: command.code, key: command.key, ctrl: command.ctrl, shift: command.shift, alt: "alt" in command ? command.alt : false, meta: false };
}
export function formatShortcut(binding: ShortcutBinding): string {
  const keyLabel: Record<string, string> = { ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→", " ": "Space" };
  return [binding.ctrl && "Ctrl", binding.alt && "Alt", binding.shift && "Shift", binding.meta && "Meta", keyLabel[binding.key] ?? binding.key.toUpperCase()].filter(Boolean).join(" + ");
}
export function validShortcutBinding(value: unknown, messageContext = false): value is ShortcutBinding {
  if (!value || typeof value !== "object") return false;
  const b = value as ShortcutBinding;
  if (typeof b.key !== "string" || !b.key || b.key.length > 32 || [b.ctrl,b.shift,b.alt,b.meta].some((v) => typeof v !== "boolean")) return false;
  if (b.meta || (!messageContext && !b.ctrl && !b.alt && !/^F([1-9]|1[0-9]|2[0-4])$/.test(b.code))) return false;
  if (!/^(Key[A-Z]|Digit[0-9]|F([1-9]|1[0-9]|2[0-4])|Slash|Backslash|BracketLeft|BracketRight|Semicolon|Quote|Comma|Period|Minus|Equal|Backquote|Arrow(Up|Down|Left|Right)|Home|End|PageUp|PageDown|Insert|Delete|Backspace|Space|Enter)$/.test(b.code)) return false;
  if (["F1","F5","F6","F10","F11","F12"].includes(b.code)) return false;
  if (b.ctrl && !b.alt && ["KeyW","KeyT","KeyN","KeyR","KeyL","KeyP","KeyJ","KeyH","KeyS","KeyO","KeyU","KeyI"].includes(b.code)) return false;
  return !(b.alt && ["F4","ArrowLeft","ArrowRight","Home","Delete","Space"].includes(b.code));
}
export function shortcutConflict(id: ShortcutId, bindings: ShortcutBindings): boolean {
  const selected = shortcutRegistry.find((command) => command.id === id)!;
  const a = commandBinding(selected, bindings);
  return shortcutRegistry.some((other) => {
    if (other.id !== id && !isShortcutEnabled(other.id, bindings)) return false;
    const b = commandBinding(other, bindings);
    const sameScope = ("context" in selected) === ("context" in other) &&
      (!("context" in selected) || !("context" in other) || selected.context === other.context);
    if (!sameScope) return false;
    return other.id !== id && a.code === b.code && a.ctrl === b.ctrl && a.shift === b.shift && a.alt === b.alt && a.meta === b.meta;
  });
}

export function resolveDefaultShortcut(event: KeyboardEvent, inputFocused: boolean, bindings: ShortcutBindings = {}) {
  if (event.defaultPrevented || event.repeat || event.isComposing) return undefined;
  return shortcutRegistry.find((command) => {
    if ("context" in command) return false;
    if (!isShortcutEnabled(command.id, bindings)) return false;
    const binding = commandBinding(command, bindings);
    return event.ctrlKey === binding.ctrl && event.shiftKey === binding.shift && event.altKey === binding.alt && event.metaKey === binding.meta &&
    (!inputFocused || command.allowInInput) &&
    (event.code ? event.code === binding.code : event.key.toLowerCase() === binding.key.toLowerCase());
  })?.id;
}

export function resolveMessageShortcut(event: KeyboardEvent, bindings: ShortcutBindings = {}) {
  return resolveContextShortcut(event, "message", bindings);
}

export function resolveContextShortcut(event: KeyboardEvent, context: ShortcutContext, bindings: ShortcutBindings = {}) {
  if (event.defaultPrevented || event.repeat || event.isComposing) return undefined;
  const command = shortcutRegistry.find((command) => {
    if (!("context" in command) || command.context !== context) return false;
    if (!isShortcutEnabled(command.id, bindings)) return false;
    const b = commandBinding(command, bindings);
    return event.code === b.code && event.ctrlKey === b.ctrl && event.shiftKey === b.shift && event.altKey === b.alt && event.metaKey === b.meta;
  });
  return command && "actionId" in command ? command.actionId : undefined;
}

export function resolveContextShortcutId(event: KeyboardEvent, context: ShortcutContext, bindings: ShortcutBindings = {}) {
  if (event.defaultPrevented || event.repeat || event.isComposing) return undefined;
  const command = shortcutRegistry.find((item) => {
    if (!("context" in item) || item.context !== context) return false;
    if (!isShortcutEnabled(item.id, bindings)) return false;
    const binding = commandBinding(item, bindings);
    return event.code === binding.code && event.ctrlKey === binding.ctrl && event.shiftKey === binding.shift && event.altKey === binding.alt && event.metaKey === binding.meta;
  });
  return command?.id;
}
