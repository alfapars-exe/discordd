/**
 * sendIntroMessage — deliver the optional "say hi" text that accompanies a
 * friend request as a regular DM. Pure client orchestration: the request
 * itself has already succeeded by the time this runs, so nothing here can
 * undo it.
 */

import { useDMStore } from "../../stores/dmStore";
import { useToastStore } from "../../stores/toastStore";
import i18n from "../../i18n";

export const INTRO_MAX_LENGTH = 200;

export type IntroSendResult = "sent" | "channel_unavailable" | "send_failed";

export async function sendIntroMessage(
  targetUserId: string,
  message: string
): Promise<IntroSendResult> {
  const text = message.trim().slice(0, INTRO_MAX_LENGTH);
  if (!text) return "sent";

  const channelId = await useDMStore.getState().createOrGetChannel(targetUserId);
  if (!channelId) {
    // The request went through but the DM could not be opened (privacy
    // "friends only", block, rate limit). Informational, not an error — the
    // user did get what they asked for.
    useToastStore.getState().addToast("info", i18n.t("common:friendIntroNotDelivered"));
    return "channel_unavailable";
  }

  // dmStore.sendMessage picks E2EE itself and already toasts on failure
  // (sendWithRetryAndToast) — no second toast here.
  const ok = await useDMStore.getState().sendMessage(channelId, text);
  return ok ? "sent" : "send_failed";
}
