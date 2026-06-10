/**
 * useServerWakeUp — auth sayfalarında "Sunucu uyanıyor" UX'i orkestre eder.
 *
 * HF Spaces uyku modundan çıkarken ilk istekler 502/503/504 + HTML döner.
 * apiClient.ts bu durumu yakalayıp `service_unavailable:` sentinel ile
 * geriye verir. Bu hook o sentinel'i izler, /api/health endpoint'ine ping
 * atmaya başlar, container ayağa kalkınca son başarısız çağrıyı tekrar
 * dener.
 *
 * State machine:
 *   idle ──(error sentinel match)──▶ waking ──(probe success)──▶ ready
 *                                       │
 *                                       └──(attempt >= max)──▶ failed
 *
 * Tasarım kararları:
 * - Probe + retry login çağrısının kendisi YERİNE yapılıyor: parola tekrar
 *   tekrar wire'a yazılmasın, DB'ye yük binmesin.
 * - Hook auth sayfasından çıkınca cleanup yapıyor (bekleyen timeout temizlenir).
 * - `lastAttempt` callback'i kapatma içinde tutuyoruz; her wake-up için tek
 *   bir retry yapılır (probe başarılı olunca).
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { pingServer } from "../utils/serverProbe";

const RETRY_POLICY = {
  /** Total probe budget — the 8th failed probe transitions to "failed". */
  maxAttempts: 8,
  /**
   * Exponential backoff between probes: 2s, 4s, 8s, 16s, then capped at 30s.
   * HF cold start typically takes 30-90s; with the 30s cap the full budget
   * spans ~2min, which covers the slow tail without probing forever.
   */
  backoff: (attempt: number) => Math.min(2_000 * 2 ** attempt, 30_000),
};

/**
 * ±20% jitter — a sleeping Space tends to fail many clients at the same
 * instant, so without jitter their retry schedules stay synchronized and
 * re-stampede the container exactly when it's trying to boot.
 */
function jitter(delayMs: number): number {
  return delayMs * (0.8 + Math.random() * 0.4);
}

function shouldRetry(error: string | null): boolean {
  if (!error) return false;
  // Sentinel match — apiClient.ts'in 502/503/504 + HTML için döndürdüğü değer.
  if (error.startsWith("service_unavailable:")) return true;
  // Cold start often surfaces as a plain fetch failure (connection refused,
  // proxy not answering yet) before the 502 sentinel ever appears — treat
  // those as "waking" too instead of dead-ending with a network error.
  if (/network request failed|failed to fetch/i.test(error)) return true;
  return false;
}

// ─────────────────────────────────────────────────────────────────────────
// Aşağısı hook implementasyonu — TODO yok, kullanıma hazır.
// ─────────────────────────────────────────────────────────────────────────

export type WakeUpState =
  | { phase: "idle" }
  | { phase: "waking"; attempt: number; max: number }
  | { phase: "failed" }
  | { phase: "ready" };

export type UseServerWakeUpOptions = {
  /** authStore.error — sentinel match ederse wake-up döngüsü başlar. */
  error: string | null;
  /**
   * Probe başarılı olunca tetiklenecek callback. Genelde son başarısız
   * çağrıyı (login/register) tekrar denemek için kullanılır. Hook bu
   * callback'i en taze haliyle çağırır (useEffect re-bind etmiyor).
   */
  onReady: () => void;
};

export type UseServerWakeUpResult = {
  state: WakeUpState;
  /** Manuel reset — başarılı login sonrası, ya da sayfa değişiminde. */
  reset: () => void;
};

export function useServerWakeUp(options: UseServerWakeUpOptions): UseServerWakeUpResult {
  const { error, onReady } = options;
  const [state, setState] = useState<WakeUpState>({ phase: "idle" });
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptRef = useRef(0);
  // pingServer is async: a probe can resolve AFTER stopLoop already ran
  // (unmount, reset). Without this flag the resolved tick would book a fresh
  // timeout that no cleanup path can ever clear.
  const activeRef = useRef(false);
  // onReady'i ref'te tutuyoruz ki tick içinde çağrı yaparken closure-stale
  // olmasın (kullanıcı render arasında callback'i değiştirmiş olabilir).
  const onReadyRef = useRef(onReady);
  // Latest-ref mirror (post-commit) — keeps tick() reading the freshest
  // onReady callback identity without re-subscribing the interval each
  // render. Writing ref.current during render is flagged by
  // react-hooks/refs.
  useLayoutEffect(() => {
    onReadyRef.current = onReady;
  });

  const stopLoop = useCallback(() => {
    activeRef.current = false;
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  const reset = useCallback(() => {
    stopLoop();
    attemptRef.current = 0;
    setState({ phase: "idle" });
  }, [stopLoop]);

  const startLoop = useCallback(() => {
    if (activeRef.current) return; // zaten çalışıyor
    activeRef.current = true;
    attemptRef.current = 0;

    // tick is a local closure (not a useCallback) so it can re-schedule
    // itself without appearing in its own dependency list.
    const tick = async (): Promise<void> => {
      timeoutRef.current = null;
      attemptRef.current += 1;
      const attempt = attemptRef.current;

      setState({ phase: "waking", attempt, max: RETRY_POLICY.maxAttempts });

      const alive = await pingServer();

      // stopLoop may have fired while the probe was in flight — touching
      // state or scheduling from here would leak past the cleanup.
      if (!activeRef.current) return;

      if (alive) {
        stopLoop();
        setState({ phase: "ready" });
        // Son başarısız çağrıyı bir kez tekrar dene — bundan sonra normal
        // hata akışı devreye girer (örn. yanlış şifre gibi gerçek hatalar
        // wake-up değil regular error olarak gösterilir).
        onReadyRef.current();
        return;
      }

      if (attempt >= RETRY_POLICY.maxAttempts) {
        stopLoop();
        setState({ phase: "failed" });
        return;
      }

      // Self-scheduling chain instead of setInterval: the next probe is
      // booked only after the current one fails, so a slow probe can't pile
      // up behind a fixed cadence, and the delay backs off exponentially
      // while the Space is still booting. `attempt - 1` keeps the curve
      // 0-indexed: the wait after the very first probe is backoff(0) = 2s.
      timeoutRef.current = setTimeout(() => {
        void tick();
      }, jitter(RETRY_POLICY.backoff(attempt - 1)));
    };

    // İlk tick'i hemen çalıştır — kullanıcı beklemeden feedback alsın.
    void tick();
  }, [stopLoop]);

  // Error değiştikçe sentinel kontrolü — idle'dan waking'e geçişin tek yeri.
  useEffect(() => {
    if (state.phase !== "idle") return;
    if (shouldRetry(error)) {
      startLoop();
    }
  }, [error, state.phase, startLoop]);

  // Unmount cleanup — timeout leak'ini önler (örn. user landing'e geri dönerse).
  useEffect(() => {
    return () => stopLoop();
  }, [stopLoop]);

  return { state, reset };
}
