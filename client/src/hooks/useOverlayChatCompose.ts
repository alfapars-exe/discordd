import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { getAuthSessionSnapshot } from "../api/authSessionEvents";
import { useAuthStore } from "../stores/authStore";
import { useVoiceStore } from "../stores/voiceStore";
import { useUIStore } from "../stores/uiStore";
import { useMessageStore } from "../stores/messageStore";
import { useDMStore } from "../stores/dmStore";
import { useGroupDMStore } from "../stores/groupDMStore";
import { getLiveOverlayChatTarget } from "../utils/overlayChatAccess";

type ChatSendRequest = { session: string; requestId: string; text: string };
type ChatSendResult = "sent" | "failed" | "unavailable";

const MAX_TEXT_LENGTH = 2000;
const MAX_REQUEST_ID_LENGTH = 128;
const MAX_MEMOIZED_REQUESTS = 64;

function hasDisallowedControl(value: string, allowLineBreaks: boolean): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      if (allowLineBreaks && (code === 0x09 || code === 0x0a)) continue;
      return true;
    }
  }
  return false;
}

function cleanRequest(value: unknown): { requestId: string; text: string } | null {
  if (!value || typeof value !== "object") return null;
  const request = value as Partial<ChatSendRequest>;
  if (typeof request.requestId !== "string" || request.requestId.length === 0
    || request.requestId.length > MAX_REQUEST_ID_LENGTH
    || hasDisallowedControl(request.requestId, false)
    || typeof request.text !== "string" || request.text.length > MAX_TEXT_LENGTH
    || hasDisallowedControl(request.text, true)) return null;
  const text = request.text.trim();
  if (text.length === 0) return null;
  return { requestId: request.requestId, text };
}

/** Handles one explicit overlay request through the regular, E2EE-aware message store. */
export function useOverlayChatCompose(connected: boolean, chatReady: boolean): string | null {
  const connectedRef = useRef(connected);
  const chatReadyRef = useRef(chatReady);
  useLayoutEffect(() => { connectedRef.current = connected; chatReadyRef.current = chatReady; }, [connected, chatReady]);
  const owner = useAuthStore((s) => s.user?.id ?? null);
  const generation = useAuthStore(() => getAuthSessionSnapshot().generation);
  const enabled = useVoiceStore((s) => !s.voiceOverlayCompatibility && s.voiceOverlayEnabled && s.voiceOverlayChat
    && s.voiceOverlayChatActions && s.voiceOverlayChatCompose);
  const destination = useUIStore((s) => s.destination);
  const composeBridge = window.electronAPI;
  const [sessionEpoch, setSessionEpoch] = useState(0);
  const initialTarget = getLiveOverlayChatTarget(true);
  const channelId = initialTarget?.channelId;
  const targetType = initialTarget?.type;
  const serverId = initialTarget?.serverInfo?.serverId;
  const eligible = enabled && connected && chatReady && !!owner && !!channelId && !!targetType
    && typeof composeBridge?.onOverlayChatSend === "function"
    && typeof composeBridge.resolveOverlayChatSend === "function";
  const binding = owner && channelId && targetType ? JSON.stringify([owner, targetType, serverId, channelId, destination]) : null;
  const session = useMemo(() => eligible && binding ? `${generation}:${sessionEpoch}:${crypto.randomUUID()}` : null,
    [eligible, generation, binding, sessionEpoch]);

  useEffect(() => {
    if (!session || !owner || !channelId || !targetType) return;
    let disposed = false;
    let closed = false;
    let busy = false;
    let inFlightRequestId: string | null = null;
    const requests = new Map<string, ChatSendResult | "pending">();
    const bridge = composeBridge;

    const currentTarget = () => {
      const scope = getAuthSessionSnapshot();
      const voice = useVoiceStore.getState();
      if (disposed || closed || !connectedRef.current || !chatReadyRef.current || voice.voiceOverlayCompatibility || !voice.voiceOverlayEnabled || !voice.voiceOverlayChat
        || !voice.voiceOverlayChatActions || !voice.voiceOverlayChatCompose
        || scope.ownerId !== owner || scope.generation !== generation
        || useAuthStore.getState().user?.id !== owner) return null;
      const target = getLiveOverlayChatTarget(true);
      return target?.type === targetType && target.channelId === channelId && target.serverInfo?.serverId === serverId ? target : null;
    };

    const remember = (requestId: string, result: ChatSendResult) => {
      if (requests.has(requestId) || requests.size < MAX_MEMOIZED_REQUESTS) requests.set(requestId, result);
    };

    const resolve = async (requestId: string, result: ChatSendResult) => {
      if (!currentTarget()) return;
      remember(requestId, result);
      try { await bridge?.resolveOverlayChatSend?.({ session, requestId, result }); }
      catch { /* The native request expires safely if the bridge disappears. */ }
    };

    const unsubscribe = bridge?.onOverlayChatSend?.((value) => {
      if (!value || value.session !== session || !currentTarget()) return;
      const request = cleanRequest(value);
      if (!request) {
        if (typeof value.requestId === "string" && value.requestId.length > 0
          && value.requestId.length <= MAX_REQUEST_ID_LENGTH && !hasDisallowedControl(value.requestId, false)) {
          void resolve(value.requestId, "failed");
        }
        return;
      }
      const previous = requests.get(request.requestId);
      if (previous === "pending") return;
      if (previous) { void resolve(request.requestId, previous); return; }
      if (requests.size >= MAX_MEMOIZED_REQUESTS) { void resolve(request.requestId, "unavailable"); return; }
      // A repeated in-flight id is covered by its original acknowledgement.
      // A different id is rejected rather than queued behind a plaintext draft.
      if (busy) {
        if (inFlightRequestId !== request.requestId) void resolve(request.requestId, "unavailable");
        return;
      }
      const target = currentTarget();
      if (!target) return;
      busy = true;
      inFlightRequestId = request.requestId;
      requests.set(request.requestId, "pending");
      void (async () => {
        let result: ChatSendResult;
        try {
          const context = { ownerId: owner, authGeneration: generation, isCurrent: () => !!currentTarget() };
          const sent = target.type === "dm"
            ? await useDMStore.getState().sendMessage(target.channelId, request.text, undefined, undefined, context)
            : target.type === "group-dm"
              ? await useGroupDMStore.getState().send(target.channelId, request.text, undefined, undefined, context)
              : await useMessageStore.getState().sendMessage(
            target.channelId, request.text, undefined, undefined, target.serverInfo?.serverId,
            { isCurrent: () => !!currentTarget() },
          );
          result = currentTarget() ? (sent === true ? "sent" : "failed") : "unavailable";
        } catch {
          result = currentTarget() ? "failed" : "unavailable";
        } finally {
          busy = false;
          inFlightRequestId = null;
        }
        await resolve(request.requestId, result);
      })().catch(() => { busy = false; inFlightRequestId = null; });
    });

    const unsubscribeClosed = composeBridge?.onOverlayChatComposerClosed?.((value) => {
      if (value?.session !== session || !currentTarget()) return;
      closed = true;
      setSessionEpoch((epoch) => epoch + 1);
    });

    return () => { disposed = true; unsubscribe?.(); unsubscribeClosed?.(); requests.clear(); };
  }, [session, owner, generation, connected, channelId, targetType, serverId, composeBridge]);

  return session;
}
