import path from "node:path";
import { hasVoiceOverlayContent, type VoiceOverlaySnapshot } from "./voice-overlay-contract";
import type { GameWindowSnapshot, GameWindowRect } from "./game-window-tracker";

type Target = { id: string; executablePath: string };
type Tracker = { start(): void; stop(): Promise<void>; getSnapshot(): GameWindowSnapshot | null };
type Options = {
  tracker: Tracker;
  getTargets(): Promise<Target[]>;
  toVisibleDipRect(rect: GameWindowRect): GameWindowRect | null;
  display(snapshot: VoiceOverlaySnapshot, bounds?: GameWindowRect, context?: string): void;
  supported: boolean;
};

function normalizedPath(value: string): string {
  return path.win32.normalize(value).replace(/^\\\\\?\\/, "").toLowerCase();
}

/** Main-only foreground policy. Neither process paths nor bounds enter renderer IPC. */
export function createGameOverlayController(options: Options) {
  let snapshot: VoiceOverlaySnapshot | null = null;
  let targets: Target[] = [];
  let generation = 0;
  let disposed = false;
  let loading = false;
  let initialized = false;

  const gameMode = () => snapshot?.voiceOverlayMode === "game";
  const wanted = () => !disposed && gameMode() && !!snapshot && hasVoiceOverlayContent(snapshot);
  const hide = () => { if (snapshot) options.display({ ...snapshot, enabled: false }); };

  function render(): void {
    if (!snapshot || disposed) return;
    if (!gameMode()) { options.display(snapshot, undefined, "desktop"); return; }
    if (!wanted() || !options.supported || loading) { hide(); return; }
    const foreground = options.tracker.getSnapshot();
    if (!foreground?.available || !foreground.executablePath || !foreground.rect) { hide(); return; }
    const target = targets.find((target) => normalizedPath(target.executablePath) === normalizedPath(foreground.executablePath!));
    if (!target) { hide(); return; }
    let bounds: GameWindowRect | null;
    try { bounds = options.toVisibleDipRect(foreground.rect); } catch { bounds = null; }
    if (!bounds || ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)
      || bounds.width <= 0 || bounds.height <= 0) { hide(); return; }
    options.display(snapshot, bounds, `game:${target.id}`);
  }

  async function policyChanged(): Promise<void> {
    const current = ++generation;
    initialized = false;
    targets = [];
    if (!wanted() || !options.supported) {
      loading = false;
      void options.tracker.stop();
      render();
      return;
    }
    loading = true;
    hide();
    try {
      await options.tracker.stop();
      if (disposed || generation !== current || !wanted()) return;
      const result = await options.getTargets();
      if (disposed || generation !== current || !wanted()) return;
      targets = result.map((target) => ({ ...target }));
      initialized = true;
      loading = false;
      if (targets.length > 0) options.tracker.start();
      else void options.tracker.stop();
      render();
    } catch {
      if (disposed || generation !== current) return;
      loading = false;
      initialized = false;
      void options.tracker.stop();
      hide();
    }
  }

  return {
    setSnapshot(next: VoiceOverlaySnapshot): void {
      if (disposed) return;
      const previousWanted = wanted();
      snapshot = next;
      if (!wanted()) {
        generation += 1;
        loading = false;
        initialized = false;
        targets = [];
        void options.tracker.stop();
        render();
      } else if (!previousWanted || (!initialized && !loading)) void policyChanged();
      else render();
    },
    policyChanged,
    foregroundChanged(): void { render(); },
    clear(): void {
      if (disposed) return;
      generation += 1;
      hide();
      snapshot = null;
      targets = [];
      loading = false;
      initialized = false;
      void options.tracker.stop();
    },
    dispose(): void {
      if (disposed) return;
      generation += 1;
      hide();
      disposed = true;
      targets = [];
      snapshot = null;
      void options.tracker.stop();
    },
  };
}
