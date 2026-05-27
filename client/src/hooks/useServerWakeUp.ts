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
 * - Hook auth sayfasından çıkınca cleanup yapıyor (interval temizlenir).
 * - `lastAttempt` callback'i kapatma içinde tutuyoruz; her wake-up için tek
 *   bir retry yapılır (probe başarılı olunca).
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { pingServer } from "../utils/serverProbe";

// ─────────────────────────────────────────────────────────────────────────
// ★ TODO(harun): Retry politikasını sen belirle.
//
// HF Spaces cold start tipik olarak 30-90sn sürer. Aşağıdaki değerleri ve
// shouldRetry mantığını ihtiyacına göre değiştir. Plan dosyasında üç seçenek
// detaylı anlatıldı:
//   1) Linear      → her denemede aynı bekleme (öngörülebilir, basit)
//   2) Exponential → 1s, 2s, 4s, 8s, 16s, 32s (sunucu yükünü düşürür)
//   3) Custom      → HF cold start eğrisine elle uydurulmuş
//
// Aynı zamanda hangi hata durumlarının "uyanıyor" sayılacağını shouldRetry
// içinde belirle: sadece sentinel mi, yoksa network error'ları da mı?
// ─────────────────────────────────────────────────────────────────────────

const RETRY_POLICY = {
  /** Toplam kaç ping denemesi yapılsın (0-indexed limit) */
  maxAttempts: 12, // ← değiştir
  /** Linear interval — her denemenin arasındaki bekleme (ms) */
  intervalMs: 5_000, // ← değiştir
  // Eğer exponential backoff istersen, intervalMs'i kaldırıp bunu kullan:
  // backoff: (attempt: number) => Math.min(1000 * 2 ** attempt, 30_000),
};

function shouldRetry(error: string | null): boolean {
  if (!error) return false;
  // Sentinel match — apiClient.ts'in 502/503/504 + HTML için döndürdüğü değer.
  if (error.startsWith("service_unavailable:")) return true;
  // ← Network error'ları da retry'a almak istersen aşağıyı aç:
  // if (/network request failed|failed to fetch/i.test(error)) return true;
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
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const attemptRef = useRef(0);
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
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  const reset = useCallback(() => {
    stopLoop();
    attemptRef.current = 0;
    setState({ phase: "idle" });
  }, [stopLoop]);

  const tick = useCallback(async () => {
    attemptRef.current += 1;
    const attempt = attemptRef.current;

    setState({ phase: "waking", attempt, max: RETRY_POLICY.maxAttempts });

    const alive = await pingServer();

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
    }
  }, [stopLoop]);

  const startLoop = useCallback(() => {
    if (intervalRef.current) return; // zaten çalışıyor
    attemptRef.current = 0;
    // İlk tick'i hemen çalıştır — kullanıcı 5sn beklemeden feedback alsın.
    void tick();
    intervalRef.current = setInterval(() => {
      void tick();
    }, RETRY_POLICY.intervalMs);
  }, [tick]);

  // Error değiştikçe sentinel kontrolü — idle'dan waking'e geçişin tek yeri.
  useEffect(() => {
    if (state.phase !== "idle") return;
    if (shouldRetry(error)) {
      startLoop();
    }
  }, [error, state.phase, startLoop]);

  // Unmount cleanup — interval leak'ini önler (örn. user landing'e geri dönerse).
  useEffect(() => {
    return () => stopLoop();
  }, [stopLoop]);

  return { state, reset };
}
