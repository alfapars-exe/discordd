/** Electron-independent global shortcut policy for the passive overlay. */

export type OverlayShortcutBinding = {
  code: string;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
};

export type OverlayShortcutAdapter = {
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
  supported?: boolean;
};

const KEY_CODES: Readonly<Record<string, string>> = (() => {
  const codes: Record<string, string> = {};
  for (let i = 0; i < 26; i += 1) codes[`Key${String.fromCharCode(65 + i)}`] = String.fromCharCode(65 + i);
  for (let i = 0; i < 10; i += 1) codes[`Digit${i}`] = String(i);
  for (let i = 1; i <= 24; i += 1) codes[`F${i}`] = `F${i}`;
  Object.assign(codes, {
    ArrowUp: "Up",
    ArrowDown: "Down",
    ArrowLeft: "Left",
    ArrowRight: "Right",
    Home: "Home",
    End: "End",
    PageUp: "PageUp",
    PageDown: "PageDown",
    Insert: "Insert",
    Delete: "Delete",
  });
  return Object.freeze(codes);
})();

function isBinding(value: unknown): value is OverlayShortcutBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const allowedKeys = new Set(["code", "ctrl", "shift", "alt", "meta"]);
  return Object.keys(row).every((key) => allowedKeys.has(key))
    && typeof row.code === "string"
    && Object.prototype.hasOwnProperty.call(KEY_CODES, row.code)
    && typeof row.ctrl === "boolean"
    && typeof row.shift === "boolean"
    && typeof row.alt === "boolean"
    && typeof row.meta === "boolean"
    && (row.ctrl || row.shift || row.alt || row.meta);
}

/** Translate a bounded KeyboardEvent.code chord into an Electron accelerator. */
export function toOverlayAccelerator(value: unknown): string | null {
  if (!isBinding(value)) return null;
  const parts: string[] = [];
  if (value.ctrl) parts.push("Ctrl");
  if (value.alt) parts.push("Alt");
  if (value.shift) parts.push("Shift");
  if (value.meta) parts.push("Super");
  parts.push(KEY_CODES[value.code]);
  return parts.join("+");
}

/**
 * Owns at most one overlay shortcut. Replacement is register-first: a chord
 * that Electron cannot reserve never displaces the previously working chord.
 */
export function createOverlayShortcutController(
  adapter: OverlayShortcutAdapter,
  onToggle: () => void,
) {
  let accelerator: string | null = null;
  let disposed = false;
  let suspended = false;
  let bindingEpoch = 0;

  return {
    setBinding(binding: OverlayShortcutBinding | null): boolean {
      if (disposed) return false;
      if (binding === null) {
        if (accelerator === null) return true;
        try {
          adapter.unregister(accelerator);
          accelerator = null; bindingEpoch++;
          return true;
        } catch {
          return false;
        }
      }
      if (suspended || adapter.supported === false) return false;
      const next = toOverlayAccelerator(binding);
      if (!next) return false;
      if (next === accelerator) return true;

      const epoch = bindingEpoch + 1;
      let registered = false;
      try { registered = adapter.register(next, () => { if (!disposed && !suspended && bindingEpoch === epoch && accelerator === next) onToggle(); }); } catch { return false; }
      if (!registered) return false;

      if (accelerator !== null) {
        try {
          adapter.unregister(accelerator);
        } catch {
          try { adapter.unregister(next); } catch { /* best effort rollback */ }
          return false;
        }
      }
      accelerator = next; bindingEpoch = epoch;
      return true;
    },
    /** Compatibility releases OS keyboard ownership, not only the callback. */
    setSuspended(value: boolean): boolean {
      suspended = value;
      if (!suspended || accelerator === null) return true;
      try { adapter.unregister(accelerator); accelerator = null; bindingEpoch++; return true; }
      catch { return false; }
    },
    getAccelerator(): string | null {
      return accelerator;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (accelerator !== null) {
        try { adapter.unregister(accelerator); } catch { /* exact-owner best effort cleanup */ }
        accelerator = null;
      }
    },
  };
}
