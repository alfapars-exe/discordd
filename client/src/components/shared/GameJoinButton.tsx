import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { getAuthGeneration, ensureFreshToken } from "../../api/client";
import { consumeGameJoinTicket, getGameJoinTargets, mintGameJoinTicket, type GameJoinTarget, type GameJoinTicket } from "../../api/gameJoin";
import { useAuthStore } from "../../stores/authStore";
import { useVoiceStore } from "../../stores/voiceStore";
import { nativeGameJoinScope, revokeNativeGameJoinScope } from "../../utils/nativeGameJoinScope";
import { dispatchConsumedGameJoin, validJoinTicket } from "../../utils/gameJoin";

/** A supported game marker offers an eligibility check, never a claim that joining is permitted. */
export default function GameJoinButton({ userId, serverId }: { userId: string; serverId?: string }) {
  const { t } = useTranslation("settings");
  const ownerId = useAuthStore(s => s.user?.id);
  const generation = useAuthStore(() => getAuthGeneration());
  const channelId = useVoiceStore(s => s.currentVoiceChannelId);
  const voiceServerId = useVoiceStore(s => s.currentVoiceServerId);
  const sharedVoice = useVoiceStore(s => !!s.currentVoiceChannelId && s.voiceStates[s.currentVoiceChannelId]?.some(member => member.user_id === userId) === true);
  const [ticket, setTicket] = useState<GameJoinTicket | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const lifetime = useRef<AbortController | null>(null);
  const busyRef = useRef(false);
  const operation = useRef(0);
  const nativeAttempt = useRef(false);
  const scope = JSON.stringify([ownerId, generation, userId, serverId, channelId, voiceServerId, sharedVoice]);
  const currentScope = useRef(scope);
  useLayoutEffect(() => { currentScope.current = scope; }, [scope]);
  useEffect(() => {
    const epoch = ++operation.current;
    queueMicrotask(() => {
      if (operation.current !== epoch) return;
      busyRef.current = false; setBusy(false); setTicket(null); setMessage("");
    });
    return () => {
      lifetime.current?.abort();
      if (nativeAttempt.current) { nativeAttempt.current = false; revokeNativeGameJoinScope(); }
    };
  }, [scope]);
  if (!ownerId || ownerId === userId) return null;
  async function act() {
    if (busyRef.current || !ownerId) return;
    const controller = new AbortController(); lifetime.current?.abort(); lifetime.current = controller;
    const intent = ++operation.current;
    const current = () => {
      const voice = useVoiceStore.getState();
      const liveShared = !!voice.currentVoiceChannelId && voice.voiceStates[voice.currentVoiceChannelId]?.some(member => member.user_id === userId) === true;
      return !controller.signal.aborted && currentScope.current === scope && useAuthStore.getState().user?.id === ownerId && getAuthGeneration() === generation
        && voice.currentVoiceChannelId === channelId && voice.currentVoiceServerId === voiceServerId && liveShared === sharedVoice;
    };
    busyRef.current = true; setBusy(true); setMessage("");
    const target: GameJoinTarget = sharedVoice && channelId && serverId === voiceServerId
      ? { target_user_id: userId, context: "voice", server_id: serverId, channel_id: channelId }
      : { target_user_id: userId, context: "friend" };
    try {
      if (!ticket || !validJoinTicket(ticket, ownerId, userId, ticket.offer_revision)) {
        setTicket(null);
        const status = await getGameJoinTargets(ownerId, [target], { isCurrent: current, signal: controller.signal });
        if (!current()) return;
        const eligible = status.data?.targets.find(item => item.target_user_id === userId && item.context === target.context);
        if (!status.success || !eligible?.joinable || !Number.isSafeInteger(eligible.offer_revision)) throw new Error("denied");
        const minted = await mintGameJoinTicket(ownerId, target, eligible.offer_revision!, { isCurrent: current, signal: controller.signal });
        if (!current()) return;
        if (!minted.success || !minted.data || !validJoinTicket(minted.data, ownerId, userId, eligible.offer_revision!)) throw new Error("denied");
        setTicket(minted.data); setMessage("gameJoinReady");
        return;
      }
      // Consume each ticket once. A failed dispatch requires a fresh authorization, never automatic navigation.
      setTicket(null);
      if (window.electronAPI) {
        const api = window.electronAPI;
        if (!api.syncGameJoinContext || !api.launchCS2GameJoin) throw new Error("unsupported");
        const scopeNonce = await nativeGameJoinScope(ownerId, generation);
        if (!current() || !scopeNonce) return;
        const accessToken = await ensureFreshToken();
        if (!current() || !accessToken) return;
        nativeAttempt.current = true;
        const result = await api.launchCS2GameJoin({ scopeNonce, ticketId: ticket.ticket_id, ticket: ticket.ticket,
          targetUserId: userId, offerRevision: ticket.offer_revision, accessToken, requestId: crypto.randomUUID() });
        nativeAttempt.current = false;
        if (current()) setMessage(result === "forwarded" ? "gameJoinForwarded" : "gameJoinUnavailable");
      } else {
        const consumed = await consumeGameJoinTicket(ownerId, ticket.ticket, { isCurrent: current, signal: controller.signal });
        if (!current()) return;
        setMessage(consumed.success && consumed.data && dispatchConsumedGameJoin(consumed.data, ticket, current) ? "gameJoinForwarded" : "gameJoinUnavailable");
      }
    } catch { if (current()) { setTicket(null); setMessage("gameJoinUnavailable"); } }
    finally { if (operation.current === intent) { busyRef.current = false; if (current()) setBusy(false); } }
  }
  return <span><button type="button" disabled={busy} onClick={event => { event.stopPropagation(); void act(); }}>{t(ticket ? "gameJoinOpenSteam" : "gameJoinCheck")}</button>
    {message && <small role="status">{t(message)}</small>}</span>;
}
