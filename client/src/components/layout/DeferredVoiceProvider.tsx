import { useEffect, useState, type ReactNode } from "react";

type Provider = typeof import("../voice/VoiceProvider").default;
let cachedProvider: Provider | null = null;
let pendingProvider: Promise<Provider> | null = null;

function loadProvider(): Promise<Provider> {
  if (cachedProvider) return Promise.resolve(cachedProvider);
  if (!pendingProvider) {
    pendingProvider = import("../voice/VoiceProvider").then(module => {
      cachedProvider = module.default;
      return cachedProvider;
    }, error => {
      pendingProvider = null; // A section-boundary retry can attempt a fresh load.
      throw error;
    });
  }
  return pendingProvider;
}

type State = { phase: "loading" } | { phase: "ready"; Provider: Provider } | { phase: "failed"; error: Error };

/** Mounted only for active voice. A regular update avoids Suspense's first-join
 * retry delay while retaining the split bundle and a stable provider identity.
 */
export default function DeferredVoiceProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>(() => cachedProvider
    ? { phase: "ready", Provider: cachedProvider } : { phase: "loading" });
  useEffect(() => {
    if (state.phase !== "loading") return;
    let active = true;
    void loadProvider().then(Provider => {
      if (active) setState({ phase: "ready", Provider });
    }, error => {
      if (active) setState({ phase: "failed", error: error instanceof Error ? error : new Error("Voice module failed to load", { cause: error }) });
    });
    return () => { active = false; };
  }, [state.phase]);
  if (state.phase === "failed") throw state.error;
  if (state.phase === "ready") {
    const Provider = state.Provider;
    return <Provider>{children}</Provider>;
  }
  return <>{children}</>;
}
