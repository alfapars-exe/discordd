import { useAuthStore } from "../stores/authStore";
import { useFriendStore } from "../stores/friendStore";
import { usePreferencesStore } from "../stores/preferencesStore";
import { classifySpam, shouldFilterSpam } from "./spamClassification";
import { useSpamDecisionStore } from "../stores/spamDecisionStore";

export function isMessageFilteredAsSpam(message: { id: string; user_id: string; content: string | null; edited_at?: string | null }, kind?: "channel" | "dm" | "group"): boolean {
  const decisions = useSpamDecisionStore.getState();
  const decision = decisions.decisions[`${kind}:${message.id}`];
  if (decisions.accountId === useAuthStore.getState().user?.id && decision?.revision === (message.edited_at ?? "original") && decision.status === "restored") return false;
  const privacy = usePreferencesStore.getState().get<{ spamFilter?: "all" | "nonfriends" | "off"; spamRestoredMessages?: Record<string, string> }>("privacy");
  if (privacy?.spamRestoredMessages?.[message.id] === (message.edited_at ?? "original")) return false;
  const friend = useFriendStore.getState().friends.some((entry) => entry.user_id === message.user_id);
  return shouldFilterSpam(classifySpam(message.content), privacy?.spamFilter ?? "nonfriends", friend, message.user_id === useAuthStore.getState().user?.id);
}
