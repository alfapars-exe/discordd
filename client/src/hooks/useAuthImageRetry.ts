/**
 * useAuthImageRetry — one-shot stale-token retry for auth-gated images.
 *
 * `/api/uploads/*` is auth-gated, and an <img> can't carry an Authorization
 * header — it authenticates with the `hichat_media` cookie, whose value is
 * the access token but whose Max-Age (30d) far outlives it. A tab left idle
 * past the access TTL therefore serves a stale cookie and the image 401s.
 *
 * So the first error is treated as "probably stale token": refresh once,
 * then re-request with a busted URL (the browser would otherwise replay the
 * cached failure). Only a second error means the file is genuinely
 * unrenderable — `failed` latches and the caller degrades its UI. Latching
 * on the FIRST error was the original bug: the tile stayed a generic card
 * for the life of the render even after the next API call had already
 * refreshed the cookie.
 *
 * Shared by the inline attachment tile and the fullscreen lightbox so the
 * two can't drift; `enabled: false` (blob / third-party URLs) fails
 * immediately with no refresh attempt.
 */

import { useEffect, useRef, useState } from "react";
import { ensureFreshToken } from "../api/client";

export function useAuthImageRetry(
  url: string,
  enabled: boolean
): { src: string; failed: boolean; handleError: () => void } {
  const [src, setSrc] = useState(url);
  const [failed, setFailed] = useState(false);
  const retriedRef = useRef(false);

  // Reset when the target changes — the lightbox host is a single instance
  // reused across images, so stale retry/failure state must not leak from
  // one image to the next. Microtask defer per react-hooks/set-state-in-effect.
  useEffect(() => {
    retriedRef.current = false;
    queueMicrotask(() => {
      setSrc(url);
      setFailed(false);
    });
  }, [url]);

  const handleError = () => {
    if (!enabled || retriedRef.current) {
      setFailed(true);
      return;
    }
    retriedRef.current = true;
    // ensureFreshToken() no-ops when the in-memory token is still valid and
    // collapses concurrent callers onto one shared refresh, so a screenful
    // of simultaneously-failing images costs a single /auth/refresh. A
    // failed refresh still gets the one retry; a second error then latches.
    void ensureFreshToken()
      .catch(() => undefined)
      .then(() => setSrc(`${url}${url.includes("?") ? "&" : "?"}r=1`));
  };

  return { src, failed, handleError };
}
