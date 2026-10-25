import { create } from "zustand";
import { commandBinding, shortcutRegistry, validShortcutBinding, shortcutConflict, type ShortcutBindings, type ShortcutBinding, type ShortcutId } from "../utils/shortcutRegistry";
const storageKey = "hichat-device-shortcuts-v1";
function validBinding(id: ShortcutId, value: unknown, contextual: boolean): value is ShortcutBinding {
  if (!validShortcutBinding(value, contextual)) return false;
  return id !== "overlay-lock" || ((value.ctrl || value.alt || value.shift || value.meta)
    && /^(Key[A-Z]|Digit[0-9]|F([1-9]|1[0-9]|2[0-4])|Arrow(Up|Down|Left|Right)|Home|End|PageUp|PageDown|Insert|Delete)$/.test(value.code));
}
function load(): ShortcutBindings {
  try {
    const data = JSON.parse(localStorage.getItem(storageKey) ?? "null");
    if (data?.version !== 1 || !data.bindings || typeof data.bindings !== "object") return {};
    const disabled = Array.isArray(data.disabled)
      ? data.disabled.filter((id: unknown): id is ShortcutId => shortcutRegistry.some((command) => command.id === id && (!("customizable" in command) || command.customizable)))
      : [];
    const bindings: ShortcutBindings = disabled.length ? { disabledCommands: disabled } : {};
    for (const command of shortcutRegistry) {
      if (("customizable" in command) && !command.customizable) continue;
      const candidate = data.bindings[command.id];
      if (!validBinding(command.id, candidate, "context" in command)) continue;
      const next = { ...bindings, [command.id]: candidate };
      if (!shortcutConflict(command.id, next)) bindings[command.id] = candidate;
    }
    return bindings;
  } catch { return {}; }
}
function persist(bindings: ShortcutBindings): boolean {
  const assignments: Partial<Record<ShortcutId, ShortcutBinding>> = {};
  for (const command of shortcutRegistry) {
    const binding = bindings[command.id];
    if (binding) assignments[command.id] = binding;
  }
  try {
    localStorage.setItem(storageKey, JSON.stringify({ version: 1, bindings: assignments, disabled: bindings.disabledCommands ?? [] }));
    return true;
  } catch { return false; }
}
type SaveResult = "invalid" | "conflict" | "storage" | null;
type State = {
  bindings: ShortcutBindings;
  save: (id: ShortcutId, binding: ShortcutBinding | null) => SaveResult;
  setEnabled: (id: ShortcutId, enabled: boolean) => SaveResult;
};
export const useShortcutBindingsStore = create<State>((set, get) => ({
  bindings: load(),
  save: (id, binding) => {
    const command = shortcutRegistry.find((command) => command.id === id);
    if (!command || ("customizable" in command && !command.customizable) || (binding !== null && !validBinding(id, binding, "context" in command))) return "invalid";
    const current = get().bindings;
    const disabledCommands = (current.disabledCommands ?? []).filter((item) => item !== id);
    const bindings: ShortcutBindings = { ...current, ...(disabledCommands.length ? { disabledCommands } : {}) };
    if (!disabledCommands.length) delete bindings.disabledCommands;
    if (binding) bindings[id] = binding; else delete bindings[id];
    if (shortcutConflict(id, bindings)) return "conflict";
    if (!persist(bindings)) return "storage";
    set({ bindings }); return null;
  },
  setEnabled: (id, enabled) => {
    const command = shortcutRegistry.find((command) => command.id === id);
    if (!command || ("customizable" in command && !command.customizable)) return "invalid";
    const current = get().bindings;
    const disabledCommands = new Set(current.disabledCommands ?? []);
    if (enabled) disabledCommands.delete(id); else disabledCommands.add(id);
    const nextDisabled = [...disabledCommands];
    const bindings: ShortcutBindings = { ...current, ...(nextDisabled.length ? { disabledCommands: nextDisabled } : {}) };
    if (enabled && "optIn" in command && command.optIn && !bindings[id]) bindings[id] = commandBinding(command, {});
    if (enabled && "optIn" in command && command.optIn && !validBinding(id, bindings[id], "context" in command)) return "invalid";
    if (!nextDisabled.length) delete bindings.disabledCommands;
    if (enabled && shortcutConflict(id, bindings)) return "conflict";
    if (!persist(bindings)) return "storage";
    set({ bindings });
    return null;
  },
}));
