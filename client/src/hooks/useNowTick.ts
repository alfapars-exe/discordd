import { useState, useEffect } from "react";

/**
 * A snapshot of Date.now() that refreshes on an interval. Lets components
 * render relative-time labels ("5m", "2h") without calling Date.now()
 * directly during render, which trips react-hooks/purity (non-deterministic
 * read). Default cadence is 30s — enough to keep labels roughly current.
 */
export function useNowTick(intervalMs = 30_000): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return nowMs;
}
