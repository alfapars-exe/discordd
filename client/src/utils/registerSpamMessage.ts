import { recordSpam, type SpamReference } from "../api/spam";
import { useAuthStore } from "../stores/authStore";
import { getAuthGeneration } from "../api/client";
import { useToastStore } from "../stores/toastStore";
import { getMessageSpamDisposition,ensureSpamRelationshipReady } from "./messageSpamPolicy";
import { classifySpam } from "./spamClassification";
import i18n from "../i18n";

type Candidate = { id: string; user_id: string; content: string | null; edited_at?: string | null };
let lastFailureToast = 0;

async function registerCandidate(message: Candidate, kind: SpamReference["source_kind"], channelId: string, isCurrent: () => boolean,resolveRelationship:boolean): Promise<boolean> {
  const accountId = useAuthStore.getState().user?.id;
  const authGeneration = getAuthGeneration();
  const requestIsCurrent = () => useAuthStore.getState().user?.id === accountId
    && getAuthGeneration() === authGeneration && isCurrent();
  if(!accountId||!requestIsCurrent())return false;
  if(resolveRelationship&&getMessageSpamDisposition(message,kind)==="pending")await ensureSpamRelationshipReady(requestIsCurrent);
  if(!requestIsCurrent())return false;
  const disposition=getMessageSpamDisposition(message,kind);
  if(disposition!=="filter")return disposition==="allow";
  const reference = { source_kind: kind, channel_id: channelId, message_id: message.id, revision: message.edited_at ?? "original", reasons: classifySpam(message.content).reasons };
  const recordCurrent=()=>requestIsCurrent()&&getMessageSpamDisposition(message,kind)==="filter";
  const response = await recordSpam(reference, undefined, recordCurrent);
  if (!recordCurrent()) return false;
  if (!response.success && Date.now() - lastFailureToast > 10000) {
    if (!recordCurrent()) return false;
    lastFailureToast = Date.now();
    useToastStore.getState().addToast("error", i18n.t("chat:spamSyncFailed"), undefined, { action: { label: i18n.t("chat:spamRetry"), onClick: () => { void registerSpamMessage(message, kind, channelId, requestIsCurrent); } } });
  }
  return response.success;
}

export function registerSpamMessage(message:Candidate,kind:SpamReference["source_kind"],channelId:string,isCurrent:()=>boolean=()=>true):Promise<boolean>{return registerCandidate(message,kind,channelId,isCurrent,true);}

export async function registerSpamBatch(messages: Candidate[], kind: SpamReference["source_kind"], channelId: string, isCurrent: () => boolean = () => true): Promise<void> {
  const accountId = useAuthStore.getState().user?.id;
  const authGeneration = getAuthGeneration();
  const requestIsCurrent = () => useAuthStore.getState().user?.id === accountId
    && getAuthGeneration() === authGeneration && isCurrent();
  if(messages.some(message=>getMessageSpamDisposition(message,kind)==="pending"))await ensureSpamRelationshipReady(requestIsCurrent);
  // Keep network work bounded while handling complete history pages.
  for (let index = 0; index < messages.length; index += 4) {
    if (!accountId || !requestIsCurrent()) return;
    await Promise.all(messages.slice(index, index + 4).map((message) => registerCandidate(message, kind, channelId, requestIsCurrent,false)));
  }
}
