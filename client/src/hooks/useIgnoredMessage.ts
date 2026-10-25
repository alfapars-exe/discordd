import { useAuthStore } from "../stores/authStore";
import { usePreferencesStore } from "../stores/preferencesStore";
import { useState } from "react";

/** Account-owned ignore policy. Never treats the account's own messages as ignored. */
export function useIgnoredMessage(authorId: string) {
  const ownerId = useAuthStore((state) => state.user?.id);
  const policy = usePreferencesStore((state) => state.data.privacy);
  const ignored = Boolean(ownerId && ownerId !== authorId && policy && typeof policy === "object" && !Array.isArray(policy) &&
    (policy as { ignoredUsers?: Record<string, boolean> }).ignoredUsers?.[authorId] === true);
  return { ignored, ownerId, policy };
}

/** A reveal is local to this account, policy revision and exact message body. */
export function useIgnoredMessageVisibility(message: { id: string; user_id: string; content: string | null; edited_at?: string | null }, channelId: string) {
  const { ignored, ownerId, policy } = useIgnoredMessage(message.user_id);
  const [reveal, setReveal] = useState<{ ownerId: string | undefined; policy: unknown; channelId: string; id: string; authorId: string; content: string | null; editedAt?: string | null } | null>(null);
  const shown = reveal !== null && reveal.ownerId === ownerId && reveal.policy === policy && reveal.channelId === channelId && reveal.id === message.id && reveal.authorId === message.user_id && reveal.content === message.content && reveal.editedAt === message.edited_at;
  return { ignored, shown, hidden: ignored && !shown, reveal: () => setReveal({ownerId,policy,channelId,id:message.id,authorId:message.user_id,content:message.content,editedAt:message.edited_at}) };
}
