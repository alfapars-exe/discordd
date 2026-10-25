import { recordSpam, type SpamReference } from "../api/spam";
import { useAuthStore } from "../stores/authStore";
import { getAuthGeneration } from "../api/client";
import { useToastStore } from "../stores/toastStore";
import { isMessageFilteredAsSpam } from "./messageSpamPolicy";
import { classifySpam } from "./spamClassification";
import i18n from "../i18n";

type Candidate = { id: string; user_id: string; content: string | null; edited_at?: string | null };
let lastFailureToast = 0;

export async function registerSpamMessage(message: Candidate, kind: SpamReference["source_kind"], channelId: string, isCurrent: () => boolean = () => true): Promise<boolean> {
  const accountId = useAuthStore.getState().user?.id;
  const authGeneration = getAuthGeneration();
  const requestIsCurrent = () => useAuthStore.getState().user?.id === accountId
    && getAuthGeneration() === authGeneration && isCurrent();
  if (!accountId || !requestIsCurrent() || !isMessageFilteredAsSpam(message, kind)) return true;
  const reference = { source_kind: kind, channel_id: channelId, message_id: message.id, revision: message.edited_at ?? "original", reasons: classifySpam(message.content).reasons };
  const response = await recordSpam(reference, undefined, requestIsCurrent);
  if (!requestIsCurrent()) return false;
  if (!response.success && Date.now() - lastFailureToast > 10000) {
    if (!requestIsCurrent()) return false;
    lastFailureToast = Date.now();
    useToastStore.getState().addToast("error", i18n.t("chat:spamSyncFailed"), undefined, { action: { label: i18n.t("chat:spamRetry"), onClick: () => { void registerSpamMessage(message, kind, channelId, requestIsCurrent); } } });
  }
  return response.success;
}

export async function registerSpamBatch(messages: Candidate[], kind: SpamReference["source_kind"], channelId: string, isCurrent: () => boolean = () => true): Promise<void> {
  const accountId = useAuthStore.getState().user?.id;
  const authGeneration = getAuthGeneration();
  const requestIsCurrent = () => useAuthStore.getState().user?.id === accountId
    && getAuthGeneration() === authGeneration && isCurrent();
  // Keep network work bounded while handling complete history pages.
  for (let index = 0; index < messages.length; index += 4) {
    if (!accountId || !requestIsCurrent()) return;
    await Promise.all(messages.slice(index, index + 4).map((message) => registerSpamMessage(message, kind, channelId, requestIsCurrent)));
  }
}
