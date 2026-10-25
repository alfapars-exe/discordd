import type { APIResponse } from "../types";
import { isMusicBotErrorReason } from "../types/music";
import i18n from "../i18n";
import { useToastStore } from "../stores/toastStore";
import { classifyApiError, showApiError } from "./apiError";

/** Translate only fixed music reason codes; provider error text stays private. */
export function showMusicRequestError(res: APIResponse<unknown>, action: "play" | "control"): void {
  if (res.success) return;
  const addToast = useToastStore.getState().addToast;
  if (res.isTimeout) {
    addToast("info", i18n.t(action === "play" ? "music:playTimeout" : "music:controlTimeout"));
    return;
  }

  const reason = res.code?.startsWith("MUSIC_") ? res.code.slice(6).toLowerCase() : undefined;
  if (isMusicBotErrorReason(reason)) {
    addToast("error", i18n.t(`music:reason_${reason}`));
    return;
  }

  // Keep actionable permission, authentication, rate-limit and network copy.
  // The contextual fallback applies only when the common classifier has none.
  if (classifyApiError(res).messageKey === "errors:unknown") {
    showApiError(res, { fallbackKey: action === "play" ? "music:playError" : "music:controlError" });
  } else {
    showApiError(res);
  }
}
