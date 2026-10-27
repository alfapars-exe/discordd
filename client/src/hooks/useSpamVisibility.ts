import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { usePreferencesStore } from "../stores/preferencesStore";
import { useFriendStore } from "../stores/friendStore";
import { useAuthStore } from "../stores/authStore";
import { classifySpam } from "../utils/spamClassification";
import {getMessageSpamDisposition,ensureSpamRelationshipReady} from "../utils/messageSpamPolicy";
import { recordSpam, decideSpam } from "../api/spam";
import { useSpamDecisionStore } from "../stores/spamDecisionStore";
import { getAuthGeneration } from "../api/client";

export function useSpamVisibility(message: { id: string; user_id: string; content: string | null; edited_at?: string | null }, source?: { kind: "channel" | "dm" | "group"; channelId: string }) {
  const userId = useAuthStore((s) => s.user?.id);
  const generation = useAuthStore(() => getAuthGeneration());
  usePreferencesStore((s) => s.get<{ spamFilter?: "all" | "nonfriends" | "off" }>("privacy")?.spamFilter ?? "nonfriends");
  // Subscribe to certainty/provenance changes even when friend IDs are stable.
  useFriendStore(s=>s.friends);useFriendStore(s=>s.ownerId);useFriendStore(s=>s.authGeneration);useFriendStore(s=>s.friendsStatus);
  const candidate=useMemo(()=>({id:message.id,user_id:message.user_id,content:message.content,edited_at:message.edited_at}),[message.id,message.user_id,message.content,message.edited_at]);
  const result = useMemo(() => classifySpam(message.content), [message.content]);
  const storedRevision = usePreferencesStore((s) => s.get<{ spamRestoredMessages?: Record<string, string> }>("privacy")?.spamRestoredMessages?.[message.id]);
  const revision = message.edited_at ?? "original";
  const remoteRestored = useSpamDecisionStore((s) => s.accountId === userId && s.decisions[`${source?.kind}:${message.id}`]?.revision === revision && s.decisions[`${source?.kind}:${message.id}`]?.status === "restored");
  const [restoredKey, setRestoredKey] = useState<string | null>(null);
  const kind = source?.kind;
  const channelId = source?.channelId;
  const key = JSON.stringify([userId, generation, kind, channelId, message.id, revision, message.content]);
  const latest = useRef<string | null>(key);
  const restores = useRef(new Set<AbortController>());
  useLayoutEffect(() => {
    latest.current = key;
    const pendingRestores = restores.current;
    return () => {
      latest.current = null;
      for (const controller of pendingRestores) controller.abort();
      pendingRestores.clear();
    };
  }, [key]);
  const current = () => latest.current === key && useAuthStore.getState().user?.id === userId && getAuthGeneration() === generation;
  const disposition=!remoteRestored&&storedRevision!==revision&&restoredKey!==key?getMessageSpamDisposition(candidate,kind):"allow";
  const hidden=disposition==="filter",pending=disposition==="pending";
  const [relationshipError,setRelationshipError]=useState<string|null>(null);
  const [relationshipRetry,setRelationshipRetry]=useState(0);
  const explicitRetryKey=useRef<string|null>(null);
  useEffect(()=>{
    if(!pending)return;
    let active=true;
    const force=explicitRetryKey.current===key;explicitRetryKey.current=null;
    void ensureSpamRelationshipReady(()=>active&&latest.current===key&&useAuthStore.getState().user?.id===userId&&getAuthGeneration()===generation,force).then(status=>{if(active&&latest.current===key)setRelationshipError(status==="pending"?key:null);});
    return ()=>{active=false;};
  },[pending,key,userId,generation,relationshipRetry]);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!hidden || !userId || !kind || !channelId) return;
    const controller = new AbortController();
    const isCurrent = () => latest.current === key && useAuthStore.getState().user?.id === userId && getAuthGeneration() === generation && !controller.signal.aborted&&getMessageSpamDisposition(candidate,kind)==="filter";
    void recordSpam({ source_kind: kind, channel_id: channelId, message_id: message.id, revision, reasons: result.reasons }, controller.signal, isCurrent).then((response) => {
      if (isCurrent()) setErrorKey(response.success ? null : key);
    }).catch(() => { if (isCurrent()) setErrorKey(key); });
    return () => controller.abort();
  }, [hidden, userId, generation, key, kind, channelId, message.id, revision, result, retry,candidate]);
  return {
    hidden,pending,pendingError:relationshipError===key,retryRelationship:()=>{explicitRetryKey.current=key;setRelationshipRetry(value=>value+1);},
    syncError: errorKey === key,
    retry: () => setRetry((value) => value + 1),
    reasons: result.reasons,
    restore: async () => {
      if (!current()||getMessageSpamDisposition(candidate,kind)!=="filter") return;
      const controller = new AbortController();
      const isCurrent = () => current() && !controller.signal.aborted;
      restores.current.add(controller);
      try {
        if (kind && channelId && userId) {
          const reference = { source_kind: kind, channel_id: channelId, message_id: message.id, revision };
          const saved = await recordSpam({ ...reference, reasons: result.reasons }, controller.signal, isCurrent);
          if (!isCurrent()) return;
          if (!saved.success) { setErrorKey(key); return; }
          const decision = await decideSpam(reference, "restore", { signal: controller.signal, isCurrent });
          if (!isCurrent()) return;
          if (!decision.success) { setErrorKey(key); return; }
          // The socket event may be delayed or lost; retain the confirmed
          // decision across remounts even when the preference map is full.
          useSpamDecisionStore.getState().apply({ user_id: userId, source_kind: kind, message_id: message.id, revision, status: "restored" });
          setErrorKey(null);
        }
        if (!isCurrent()) return;
        setRestoredKey(key);
        const store = usePreferencesStore.getState();
        const privacy = store.get<{ spamRestoredMessages?: Record<string, string> }>("privacy");
        const restored = privacy?.spamRestoredMessages ?? {};
        // At the bounded preference limit keep this reveal session-local.
        if (store.accountId === userId && (storedRevision !== undefined || Object.keys(restored).length < 1024)) {
          store.set({ privacy: { spamRestoredMessages: { [message.id]: revision } } });
        }
      } catch { if (isCurrent()) setErrorKey(key); }
      finally { restores.current.delete(controller); }
    },
  };
}
