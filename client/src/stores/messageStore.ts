/**
 * Message Store — Channel message state management.
 */

import { create } from "zustand";
import i18n from "../i18n";
import { getAuthGeneration } from "../api/client";
import {
  getAuthSessionOwner,
  subscribeAuthGenerationChanges,
  subscribeAuthOwnerChanges,
} from "../api/authSessionEvents";
import * as messageApi from "../api/messages";
import * as serversApi from "../api/servers";
import * as reactionApi from "../api/reactions";
import { useServerStore } from "./serverStore";
import { useE2EEStore } from "./e2eeStore";
import { registerSpamBatch } from "../utils/registerSpamMessage";
import { useReadStateStore } from "./readStateStore";
import { useToastStore } from "./toastStore";
import { useComposerDraftStore } from "./composerDraftStore";
import {
  encryptChannelMessage,
  decryptChannelMessages,
  SuppressedRosterError,
} from "../crypto/channelEncryption";
import { encodePayload } from "../crypto/e2eePayload";
import * as keyStorage from "../crypto/keyStorage";
import type { Message, ReactionGroup, Server } from "../types";
import { DEFAULT_MESSAGE_LIMIT } from "../utils/constants";
import {
  encryptFilesForE2EE,
  createTypingHandler,
  updateMessageInRecord,
  deleteMessageFromRecord,
  updateReactionInRecord,
  updateAuthorInRecord,
} from "./shared/messageUtils";
import { sendWithRetryAndToast } from "./shared/sendWithRetry";
import { channelSendIntent, completeChannelSendIntent, clearChannelSendIntents, supportsDurableChannelSends } from "./shared/channelSendIntent";

/** The sidebar server list is only labels/icons, never an encryption policy. */
async function resolveMessageServer(serverId: string): Promise<Server | null> {
  const activeServer = useServerStore.getState().activeServer;
  if (activeServer?.id === serverId && typeof activeServer.e2ee_enabled === "boolean") return activeServer;
  try {
    const response = await serversApi.getServer(serverId);
    return response.success && response.data?.id === serverId && typeof response.data.e2ee_enabled === "boolean" ? response.data : null;
  } catch {
    return null;
  }
}

function showEncryptionFailure() {
  useToastStore.getState().addToast("error", i18n.t("e2ee:encryptionFailed"));
}

type MessageState = {
  /** Account/session that owns all channel-keyed cached messages below. */
  ownerId: string | null;
  authGeneration: number;
  /** channelId -> Message[] */
  messagesByChannel: Record<string, Message[]>;
  hasMoreByChannel: Record<string, boolean>;
  /**
   * channelId -> newer messages exist AFTER the loaded window. Only true
   * after a jump (fetchAroundMessage) landed somewhere in the past; while
   * set, live WS inserts are dropped (they would attach to the wrong end)
   * and the list offers "jump to present" instead.
   */
  hasMoreAfterByChannel: Record<string, boolean>;
  /**
   * channelId -> fetch in flight. Per-channel, not global: with split panes
   * several channels are visible at once, and one channel's fetch must not
   * blank every other pane's message list with a skeleton.
   */
  isLoadingByChannel: Record<string, boolean>;
  isLoadingMore: boolean;
  /** channelId -> username[] */
  typingUsers: Record<string, string[]>;

  /** Last WS-deleted message ref. Snapshot consumers (search panel results)
   *  subscribe to this narrow field to drop rows that no longer exist,
   *  without depending on the loaded message window. */
  lastDeleted: { id: string; channel_id: string } | null;

  // ─── Reply State ───
  replyingTo: Message | null;
  scrollToMessageId: string | null;

  // ─── Actions ───
  fetchMessages: (channelId: string, serverId?: string) => Promise<void>;
  fetchOlderMessages: (channelId: string, serverId?: string) => Promise<void>;
  /**
   * Replace the channel's window with one centred on `messageId` (jump to
   * message). Resolves false when the message no longer exists. Does NOT
   * mark the channel read — the user is looking at the past, not the tail.
   */
  fetchAroundMessage: (serverId: string, channelId: string, messageId: string, options?: { isCurrent?: () => boolean; timeoutMs?: number }) => Promise<boolean>;
  /** Append the next page after the window's last message (forward paging). */
  fetchNewerMessages: (channelId: string, serverId?: string) => Promise<void>;
  /** Drop a jumped-to window and reload the channel tail. */
  jumpToPresent: (channelId: string, serverId?: string) => void;
  /** Clear fetch cache — forces re-fetch + re-decrypt (E2EE restore) */
  invalidateFetchCache: () => void;
  /**
   * Drop the fetched-guard only, keeping every loaded message on screen.
   * For WS reconnects, where the window may have missed echoes but is not
   * otherwise wrong — see the action body.
   */
  invalidateFetchedFlags: () => void;
  sendMessage: (channelId: string, content: string, files?: File[], replyToId?: string, serverId?: string, context?: { isCurrent: () => boolean }) => Promise<boolean>;
  editMessage: (messageId: string, content: string, serverId?: string) => Promise<boolean>;
  deleteMessage: (messageId: string, serverId?: string) => Promise<boolean>;

  // ─── Reply Actions ───
  setReplyingTo: (message: Message | null) => void;
  setScrollToMessageId: (id: string | null) => void;

  // ─── Reactions ───
  toggleReaction: (messageId: string, channelId: string, emoji: string, serverId?: string) => Promise<void>;

  // ─── WS Event Handlers ───
  handleMessageCreate: (message: Message, expectedSession?: { ownerId: string; authGeneration: number }) => void;
  handleMessageUpdate: (message: Message, expectedSession?: { ownerId: string; authGeneration: number }) => void;
  handleMessageDelete: (data: { id: string; channel_id: string }) => void;
  handleTypingStart: (channelId: string, username: string) => void;
  handleReactionUpdate: (data: { message_id: string; channel_id: string; reactions: ReactionGroup[] }) => void;
  /** Update author info across all cached messages (display_name, avatar change). */
  handleAuthorUpdate: (userId: string, patch: { display_name?: string | null; avatar_url?: string | null }) => void;
};

/**
 * Tracks channels that have been fetched from API (not just WS-buffered).
 * Separate from messagesByChannel because WS messages can buffer before fetch completes.
 */
const fetchedChannels = new Set<string>();

/**
 * Per-channel AbortController for in-flight fetchMessages calls. When the
 * user switches channels (or this store's invalidateFetchCache is called),
 * any pending request for the abandoned channel is aborted so its late
 * setState can't trample the active channel's view.
 *
 * Keyed by channelId so two channels fetching concurrently don't cancel
 * each other — only a SECOND fetch for the SAME channel aborts the first.
 */
const inflightFetches = new Map<string, AbortController>();

/** Channels with a forward (?after=) page in flight — one at a time each. */
const inflightNewerFetches = new Map<string, symbol>();
const inflightOlderFetches = new Map<string, { token: symbol; controller: AbortController }>();

/**
 * Channels with a jump (fetchAroundMessage) in flight. Claimed synchronously
 * before the first await so MessageList's mount-time fetchMessages — which
 * would otherwise abort the jump via abortChannelFetch — skips the channel.
 * Keyed to the owning controller so a superseded jump can't release a newer one's claim.
 */
const aroundPending = new Map<string, AbortController>();

/**
 * Live messages that arrived while the channel showed a jumped-to window
 * (hasMoreAfter). They can't be appended there — the window's end isn't the
 * tail — so they wait here and are merged once forward paging reaches the
 * end. jumpToPresent / invalidateFetchCache discard them (a refetch covers it).
 */
const detachedWsMessages = new Map<string, Message[]>();

/** Abort an in-flight fetch for the given channel, if any. */
function abortChannelFetch(channelId: string): void {
  const ctrl = inflightFetches.get(channelId);
  if (ctrl) {
    ctrl.abort();
    inflightFetches.delete(channelId);
  }
}

type MessageSession = { ownerId: string; authGeneration: number; draftGeneration: number };
type AuthSession = Pick<MessageSession, "ownerId" | "authGeneration">;

function sessionStillCurrent(session: AuthSession): boolean {
  const store = useMessageStore.getState();
  return getAuthSessionOwner() === session.ownerId
    && getAuthGeneration() === session.authGeneration
    && store.ownerId === session.ownerId && store.authGeneration === session.authGeneration;
}

function sendSessionStillCurrent(session: MessageSession): boolean {
  return sessionStillCurrent(session)
    && useComposerDraftStore.getState().generation === session.draftGeneration;
}

function clearMessageCaches(ownerId: string | null, authGeneration: number): void {
  clearChannelSendIntents();
  for (const controller of inflightFetches.values()) controller.abort();
  for (const controller of aroundPending.values()) controller.abort();
  for (const request of inflightOlderFetches.values()) request.controller.abort();
  inflightFetches.clear();
  inflightOlderFetches.clear();
  inflightNewerFetches.clear();
  aroundPending.clear();
  fetchedChannels.clear();
  detachedWsMessages.clear();
  useMessageStore.setState({
    messagesByChannel: {}, hasMoreByChannel: {}, hasMoreAfterByChannel: {},
    isLoadingByChannel: {}, isLoadingMore: false, typingUsers: {},
    lastDeleted: null, replyingTo: null, scrollToMessageId: null,
    ownerId, authGeneration,
  });
}

function syncMessageSession(): void {
  const ownerId = getAuthSessionOwner();
  const authGeneration = getAuthGeneration();
  const state = useMessageStore.getState();
  if (state.ownerId !== ownerId || state.authGeneration !== authGeneration) {
    clearMessageCaches(ownerId, authGeneration);
  }
}

function currentMessageSession(): MessageSession | null {
  syncMessageSession();
  const ownerId = getAuthSessionOwner();
  if (!ownerId) return null;
  return { ownerId, authGeneration: getAuthGeneration(), draftGeneration: useComposerDraftStore.getState().generation };
}

/**
 * Extracts the created Message from a send response. 201 returns the message
 * directly; 207 Multi-Status (some attachments failed) wraps it as
 * `{ message, upload_failures }`.
 */
function unwrapSentMessage(data: unknown): Message | null {
  if (!data || typeof data !== "object") return null;
  if ("id" in data) return data as Message;
  const wrapped = (data as { message?: Message }).message;
  return wrapped && typeof wrapped === "object" && "id" in wrapped ? wrapped : null;
}

export const useMessageStore = create<MessageState>((set, get) => {
  const handleTyping = createTypingHandler(set);
  return ({
  ownerId: getAuthSessionOwner(),
  authGeneration: getAuthGeneration(),
  messagesByChannel: {},
  hasMoreByChannel: {},
  hasMoreAfterByChannel: {},
  isLoadingByChannel: {},
  isLoadingMore: false,
  typingUsers: {},
  lastDeleted: null,
  replyingTo: null,
  scrollToMessageId: null,

  invalidateFetchCache: () => {
    // Cancel any in-flight fetches; their late completion would re-populate
    // messagesByChannel with stale ciphertext encrypted against the
    // pre-restore E2EE state.
    syncMessageSession();
    clearMessageCaches(get().ownerId, get().authGeneration);
  },

  invalidateFetchedFlags: () => {
    // Reconnect variant of invalidateFetchCache. A dropped socket can lose
    // the message_create echo for a message we successfully POSTed — and
    // since channel messages have no optimistic insert, that message is
    // simply absent, which reads to the user as "the send failed". The
    // fetchedChannels guard would otherwise keep the channel from ever
    // being fetched again for the life of the tab.
    //
    // Deliberately does NOT touch messagesByChannel: the cached window is
    // stale, not wrong, and clearing it would blank every open channel on
    // each reconnect before the refetch lands. The refetch merges over it.
    for (const ctrl of inflightFetches.values()) ctrl.abort();
    for (const ctrl of aroundPending.values()) ctrl.abort();
    for (const request of inflightOlderFetches.values()) request.controller.abort();
    inflightFetches.clear();
    inflightOlderFetches.clear();
    inflightNewerFetches.clear();
    aroundPending.clear();
    fetchedChannels.clear();
    detachedWsMessages.clear();
    set({ hasMoreAfterByChannel: {}, isLoadingByChannel: {}, isLoadingMore: false });
  },

  fetchMessages: async (channelId, explicitServerId?) => {
    const session = currentMessageSession();
    if (!session) return;
    const isCurrent = () => sessionStillCurrent(session);
    // A jump in flight owns the channel — see aroundPending.
    if (fetchedChannels.has(channelId) || aroundPending.has(channelId)) return;

    // If a previous fetch for this channel is still in flight, cancel it.
    // The two main triggers: user spam-clicking channels, and E2EE store
    // refreshing then re-triggering a fetch. Either way we don't want the
    // late response to clobber whatever the user is now looking at.
    abortChannelFetch(channelId);
    const controller = new AbortController();
    inflightFetches.set(channelId, controller);

    const setLoading = (loading: boolean) =>
      set((state) => ({
        isLoadingByChannel: { ...state.isLoadingByChannel, [channelId]: loading },
      }));
    // Abort paths must clear the flag too — but only when no NEWER fetch
    // owns this channel, or the replacement fetch's own flag would be
    // clobbered by the aborted one resolving late (permanent skeleton bug).
    const clearLoadingIfOwner = () => {
      if (!isCurrent()) return;
      const owner = inflightFetches.get(channelId);
      if (!owner || owner === controller) setLoading(false);
    };

    setLoading(true);

    const serverId = explicitServerId ?? useServerStore.getState().activeServerId;
    if (!serverId) {
      inflightFetches.delete(channelId);
      setLoading(false);
      return;
    }

    const res = await messageApi.getMessages(serverId, channelId, undefined, DEFAULT_MESSAGE_LIMIT, {
      signal: controller.signal, isCurrent,
    });

    // Aborted while the request was in flight — drop the response. Cache
    // invalidate also aborts, so this branch covers both user-switch and
    // E2EE-rotation cases without polluting messagesByChannel.
    if (controller.signal.aborted || !isCurrent()) {
      clearLoadingIfOwner();
      return;
    }

    if (res.success && res.data) {
      // Go nil slice -> JSON null; fallback to empty array
      const apiMessages = await decryptChannelMessages(res.data.messages ?? [], serverId, isCurrent);
      if (!controller.signal.aborted && isCurrent()) void registerSpamBatch(apiMessages, "channel", channelId, isCurrent);

      // Re-check abort after the async decrypt — a fast channel-switch
      // during decryption would otherwise still write stale content. The
      // controller stays registered in inflightFetches until AFTER this
      // check so invalidateFetchCache during the decrypt still reaches it.
      if (controller.signal.aborted || !isCurrent()) {
        clearLoadingIfOwner();
        return;
      }
      inflightFetches.delete(channelId);

      // Mark fetched only now that we're committed to writing the result.
      // Marking earlier left an aborted channel flagged as fetched-but-empty,
      // which the guard at the top then made permanently unfetchable.
      fetchedChannels.add(channelId);

      set((state) => {
        // Merge WS-buffered messages that arrived during fetch
        const buffered = state.messagesByChannel[channelId] ?? [];
        const apiIds = new Set(apiMessages.map((m) => m.id));
        const newFromWS = buffered.filter((m) => !apiIds.has(m.id));

        return {
          messagesByChannel: {
            ...state.messagesByChannel,
            [channelId]: [...apiMessages, ...newFromWS],
          },
          hasMoreByChannel: {
            ...state.hasMoreByChannel,
            [channelId]: res.data!.has_more,
          },
          isLoadingByChannel: { ...state.isLoadingByChannel, [channelId]: false },
        };
      });

      // Auto-mark-read after messages load
      const allMessages = get().messagesByChannel[channelId];
      if (allMessages && allMessages.length > 0) {
        if (!isCurrent()) return;
        const lastMsg = allMessages[allMessages.length - 1];
        useReadStateStore.getState().markAsRead(channelId, lastMsg.id);
      }
    } else {
      inflightFetches.delete(channelId);
      setLoading(false);
    }
  },

  fetchOlderMessages: async (channelId, explicitServerId?) => {
    const session = currentMessageSession();
    if (!session) return;
    const isCurrent = () => sessionStillCurrent(session);
    const messages = get().messagesByChannel[channelId];
    if (!messages || messages.length === 0) return;
    if (!get().hasMoreByChannel[channelId]) return;

    const token = Symbol("older-page");
    const controller = new AbortController();
    inflightOlderFetches.get(channelId)?.controller.abort();
    inflightOlderFetches.set(channelId, { token, controller });
    set({ isLoadingMore: true });

    const serverId = explicitServerId ?? useServerStore.getState().activeServerId;
    if (!serverId) { inflightOlderFetches.delete(channelId); set({ isLoadingMore: false }); return; }

    const beforeId = messages[0].id;
    try {
    const res = await messageApi.getMessages(serverId, channelId, beforeId, DEFAULT_MESSAGE_LIMIT, {
      signal: controller.signal, isCurrent,
    });
    if (controller.signal.aborted || !isCurrent() || inflightOlderFetches.get(channelId)?.token !== token) return;

    if (res.success && res.data) {
      const decrypted = await decryptChannelMessages(res.data.messages ?? [], serverId, isCurrent);
      if (controller.signal.aborted || !isCurrent() || inflightOlderFetches.get(channelId)?.token !== token) return;
      void registerSpamBatch(decrypted, "channel", channelId, isCurrent);
      if (!isCurrent()) return;

      set((state) => ({
        messagesByChannel: {
          ...state.messagesByChannel,
          [channelId]: [...decrypted, ...state.messagesByChannel[channelId]],
        },
        hasMoreByChannel: {
          ...state.hasMoreByChannel,
          [channelId]: res.data!.has_more,
        },
        isLoadingMore: false,
      }));
    } else {
      set({ isLoadingMore: false });
    }
    } finally {
      if (inflightOlderFetches.get(channelId)?.token === token) {
        inflightOlderFetches.delete(channelId);
        if (isCurrent()) set({ isLoadingMore: false });
      }
    }
  },

  fetchAroundMessage: async (serverId, channelId, messageId, options) => {
    const session = currentMessageSession();
    if (!session) return false;
    const requestAuthGeneration = getAuthGeneration();
    const requestUserId = getAuthSessionOwner();
    const sameAuthSession = () => sessionStillCurrent(session)
      && getAuthGeneration() === requestAuthGeneration
      && getAuthSessionOwner() === requestUserId;
    const scopeCurrent = () => {
      try {
        return sameAuthSession() && options?.isCurrent?.() !== false;
      } catch {
        return false;
      }
    };
    // A stale caller must not cancel or replace a valid in-flight request.
    if (!scopeCurrent()) return false;

    // Same abort discipline as fetchMessages: the tail fetch MessageList
    // kicks off on mount must not land after this window and replace it.
    abortChannelFetch(channelId);
    const controller = new AbortController();
    inflightFetches.set(channelId, controller);
    // Claim BEFORE the first await: MessageList mounts (tab just opened)
    // and calls fetchMessages while this request is in flight.
    aroundPending.set(channelId, controller);
    const release = () => {
      if (aroundPending.get(channelId) === controller) aroundPending.delete(channelId);
    };
    const clearLoadingIfOwner = () => {
      // A cancelled old-account operation must never publish into the new
      // account's reset store, even when its former controller is no longer
      // present in the ownership map.
      if (!sameAuthSession()) return;
      const owner = inflightFetches.get(channelId);
      if (!owner || owner === controller) {
        set((state) => ({
          isLoadingByChannel: { ...state.isLoadingByChannel, [channelId]: false },
        }));
      }
    };
    const abandon = () => {
      controller.abort();
      if (inflightFetches.get(channelId) === controller) inflightFetches.delete(channelId);
      release();
      clearLoadingIfOwner();
      return false;
    };

    set((state) => ({
      isLoadingByChannel: { ...state.isLoadingByChannel, [channelId]: true },
    }));

    let res: Awaited<ReturnType<typeof messageApi.getMessagesAround>>;
    try {
      res = await messageApi.getMessagesAround(
        serverId,
        channelId,
        messageId,
        DEFAULT_MESSAGE_LIMIT,
        { signal: controller.signal, timeoutMs: options?.timeoutMs, isCurrent: scopeCurrent }
      );
    } catch (error) {
      abandon();
      throw error;
    }
    if (controller.signal.aborted || !scopeCurrent()) return abandon();

    const page = res.success ? res.data : undefined;
    const raw = page?.messages ?? [];
    if (!page || !raw.some((m) => m.id === messageId)) {
      // 404 (deleted) or a page that doesn't contain the target — keep
      // whatever window the channel had; if it had none (the claim made
      // MessageList skip its fetch), load the tail now.
      inflightFetches.delete(channelId);
      release();
      clearLoadingIfOwner();
      if (scopeCurrent()) void get().fetchMessages(channelId, serverId);
      return false;
    }

    if (!scopeCurrent()) return abandon();
    let decrypted: Message[];
    try {
      decrypted = await decryptChannelMessages(raw, serverId, () => sameAuthSession() && scopeCurrent());
    } catch (error) {
      abandon();
      throw error;
    }
    if (controller.signal.aborted || !scopeCurrent()) return abandon();
    void registerSpamBatch(decrypted, "channel", channelId, () => sameAuthSession() && scopeCurrent());
    if (controller.signal.aborted || !scopeCurrent()) return abandon();
    inflightFetches.delete(channelId);

    // Mark fetched so a later fetchMessages() is a no-op and doesn't pull
    // the tail over this window; the claim is no longer needed after that.
    fetchedChannels.add(channelId);
    release();
    detachedWsMessages.delete(channelId);
    set((state) => ({
      messagesByChannel: { ...state.messagesByChannel, [channelId]: decrypted },
      hasMoreByChannel: { ...state.hasMoreByChannel, [channelId]: page.has_more },
      hasMoreAfterByChannel: {
        ...state.hasMoreAfterByChannel,
        [channelId]: page.has_more_after ?? false,
      },
      isLoadingByChannel: { ...state.isLoadingByChannel, [channelId]: false },
    }));
    return true;
  },

  fetchNewerMessages: async (channelId, explicitServerId?) => {
    const session = currentMessageSession();
    if (!session) return;
    const isCurrent = () => sessionStillCurrent(session);
    const messages = get().messagesByChannel[channelId];
    if (!messages || messages.length === 0) return;
    if (!get().hasMoreAfterByChannel[channelId]) return;
    if (inflightNewerFetches.has(channelId)) return;

    const serverId = explicitServerId ?? useServerStore.getState().activeServerId;
    if (!serverId) return;

    const token = Symbol("newer-page");
    inflightNewerFetches.set(channelId, token);
    const afterId = messages[messages.length - 1].id;
    try {
      const res = await messageApi.getMessagesAfter(
        serverId, channelId, afterId, DEFAULT_MESSAGE_LIMIT
      );
      if (!isCurrent() || inflightNewerFetches.get(channelId) !== token || !res.success || !res.data) return;
      const decrypted = await decryptChannelMessages(res.data.messages ?? [], serverId, isCurrent);
      if (!isCurrent() || inflightNewerFetches.get(channelId) !== token) return;
      void registerSpamBatch(decrypted, "channel", channelId, isCurrent);
      if (!isCurrent()) return;
      const hasMoreAfter = res.data.has_more_after ?? false;
      // Reached the tail: live messages held back while detached belong
      // after it now (dedup by id below — the page may already carry them).
      const held = hasMoreAfter ? [] : detachedWsMessages.get(channelId) ?? [];
      if (!hasMoreAfter) detachedWsMessages.delete(channelId);

      set((state) => {
        const current = state.messagesByChannel[channelId] ?? [];
        const seen = new Set(current.map((m) => m.id));
        const appended: Message[] = [];
        for (const m of [...decrypted, ...held]) {
          if (seen.has(m.id)) continue;
          seen.add(m.id);
          appended.push(m);
        }
        return {
          messagesByChannel: {
            ...state.messagesByChannel,
            [channelId]: [...current, ...appended],
          },
          hasMoreAfterByChannel: { ...state.hasMoreAfterByChannel, [channelId]: hasMoreAfter },
        };
      });
    } finally {
      if (inflightNewerFetches.get(channelId) === token) inflightNewerFetches.delete(channelId);
    }
  },

  jumpToPresent: (channelId, explicitServerId?) => {
    if (!currentMessageSession()) return;
    abortChannelFetch(channelId);
    fetchedChannels.delete(channelId);
    aroundPending.delete(channelId);
    detachedWsMessages.delete(channelId);
    set((state) => {
      const { [channelId]: _, ...messagesByChannel } = state.messagesByChannel;
      const { [channelId]: __, ...hasMoreByChannel } = state.hasMoreByChannel;
      return {
        messagesByChannel,
        hasMoreByChannel,
        hasMoreAfterByChannel: { ...state.hasMoreAfterByChannel, [channelId]: false },
      };
    });
    void get().fetchMessages(channelId, explicitServerId);
  },

  sendMessage: async (channelId, content, files, replyToId, explicitServerId?, context?) => {
    const session = currentMessageSession();
    if (!session) return false;
    const serverId = explicitServerId ?? useServerStore.getState().activeServerId;
    if (!serverId) return false;
    const isCurrentSession = () => sendSessionStillCurrent(session) && (!context || context.isCurrent());
    if (!isCurrentSession()) return false;
    const server = await resolveMessageServer(serverId);
    if (!isCurrentSession()) return false;
    // Never infer plaintext from another selected server or unloaded metadata.
    if (!server) {
      useToastStore.getState().addToast("error", i18n.t("chat:sendFailed"));
      return false;
    }

    // Sending from a jumped-to window: return to the tail first so the
    // sender's own message (inserted below via handleMessageCreate) lands
    // in the refetch's WS-buffer merge instead of being held back.
    if (get().hasMoreAfterByChannel[channelId]) get().jumpToPresent(channelId, serverId);

    // E2EE: encrypt with Sender Key
    const intentKey = JSON.stringify([session.ownerId, session.authGeneration, serverId, channelId]);
    const intent = channelSendIntent(intentKey, content, files, replyToId);
    const e2eeState = useE2EEStore.getState();
    if (server.e2ee_enabled) {
      const currentUserId = getAuthSessionOwner();
      if (e2eeState.initStatus !== "ready" || !e2eeState.localDeviceId || !currentUserId) {
        showEncryptionFailure();
        return false;
      }
      if (currentUserId) {
        try {
          let encryptedFiles = intent.encrypted?.files;
          let fileMetas = intent.encrypted?.metas;

          if (!intent.encrypted && files && files.length > 0) {
            const result = await encryptFilesForE2EE(files);
            if (!isCurrentSession()) return false;
            encryptedFiles = result.files;
            fileMetas = result.metas;
          }

          const plaintext = encodePayload(content, fileMetas);
          if (!isCurrentSession()) return false;

          const senderKeyMsg = intent.encrypted ? null : await encryptChannelMessage(
            channelId,
            currentUserId,
            e2eeState.localDeviceId,
            plaintext,
            serverId
          );
          if (!isCurrentSession()) return false;
          const ciphertext = intent.encrypted?.ciphertext ?? JSON.stringify(senderKeyMsg);
          // The server cannot read mentions out of ciphertext, so the
          // recipient ids ride along in plaintext metadata (ids only — no
          // message text). `content` is already tokenised (<@userId>);
          // role mentions (<@&roleId>) deliberately don't match.
          const mentionUserIds = [
            ...new Set([...content.matchAll(/<@([a-z0-9]+)>/g)].map((m) => m[1])),
          ];
          const metadata = intent.encrypted?.metadata ?? JSON.stringify({
            distribution_id: senderKeyMsg!.distributionId,
            ...(mentionUserIds.length ? { mention_user_ids: mentionUserIds } : {}),
          });

          intent.encrypted ??= { ciphertext, metadata, device: e2eeState.localDeviceId, files: encryptedFiles, metas: fileMetas };

          if (!isCurrentSession()) return false;
          const res = await sendWithRetryAndToast(() => isCurrentSession()
            ? messageApi.sendEncryptedMessage(
              serverId,
              channelId,
              ciphertext,
              intent.encrypted!.device,
              metadata,
              encryptedFiles,
              replyToId,
              { isCurrent: isCurrentSession, clientMessageId: intent.id }
            ) : Promise.resolve({ success: false }), { isCurrent: isCurrentSession, idempotent: supportsDurableChannelSends() });
          if (!isCurrentSession()) return false;
          if (res.success) {
            completeChannelSendIntent(intentKey, intent);
            const created = unwrapSentMessage(res.data);
            if (created) {
              // Insert the 201 body so the sender's own message never depends
              // on the WS echo (a dropped socket loses it). The body carries
              // ciphertext with content:null — inserting it raw would make the
              // later decrypted echo hit the id-dedupe and leave the message
              // permanently unreadable, so overlay the plaintext we just
              // encrypted. handleMessageCreate dedupes by id either way.
              get().handleMessageCreate({ ...created, content, e2ee_file_keys: fileMetas }, session);
              if (content) {
                // Sender-key ratchets can't re-decrypt our own past messages
                // on refetch — persist the plaintext like the echo path does.
                if (!isCurrentSession()) return false;
                keyStorage.cacheDecryptedMessage({
                  messageId: created.id,
                  channelId,
                  dmChannelId: null,
                  content,
                  timestamp: new Date(created.created_at).getTime(),
                }, isCurrentSession).catch(() => {});
              }
            }
          }
          return res.success;
        } catch (err) {
          if (!isCurrentSession()) return false;
          console.error("[messageStore] E2EE encryption failed:", err);
          // A suppressed roster is a security event, not a transient failure:
          // the server claimed this channel has no readable recipients while
          // the member list says otherwise, which is what a targeted-censorship
          // attempt looks like from the client. The user must be able to tell
          // it apart from "try again in a second".
          useToastStore
            .getState()
            .addToast(
              "error",
              i18n.t(
                err instanceof SuppressedRosterError
                  ? "e2ee:rosterSuppressed"
                  : "e2ee:encryptionFailed"
              )
            );
          return false;
        }
      }
    }

    // Only a confirmed non-E2EE origin server may use plaintext.
    const res = await sendWithRetryAndToast(() => isCurrentSession()
      ? messageApi.sendMessage(serverId, channelId, content, files, replyToId,
        { isCurrent: isCurrentSession, clientMessageId: intent.id })
      : Promise.resolve({ success: false }), { isCurrent: isCurrentSession, idempotent: supportsDurableChannelSends() });
    if (!isCurrentSession()) return false;
    if (res.success) {
      completeChannelSendIntent(intentKey, intent);
      // Insert the 201 body directly: the sender's view of their own message
      // must not depend on the WS echo, which a dead/reconnecting socket
      // silently loses. handleMessageCreate dedupes by id, so the echo
      // arriving before or after this insert is harmless.
      const created = unwrapSentMessage(res.data);
      if (created) get().handleMessageCreate(created);
    }
    return res.success;
  },

  editMessage: async (messageId, content, explicitServerId?) => {
    const session = currentMessageSession();
    if (!session) return false;
    const serverId = explicitServerId ?? useServerStore.getState().activeServerId;
    if (!serverId) return false;
    const isCurrentSession = () => sendSessionStillCurrent(session);
    const server = await resolveMessageServer(serverId);
    if (!isCurrentSession()) return false;
    if (!server) {
      useToastStore.getState().addToast("error", i18n.t("chat:sendFailed"));
      return false;
    }

    // E2EE encrypted edit
    const e2eeState = useE2EEStore.getState();
    if (server.e2ee_enabled) {
      const currentUserId = getAuthSessionOwner();
      if (e2eeState.initStatus !== "ready" || !e2eeState.localDeviceId || !currentUserId) {
        showEncryptionFailure();
        return false;
      }
      // Find which channel this message belongs to
      const allChannels = get().messagesByChannel;
      let channelId: string | null = null;
      for (const [chId, msgs] of Object.entries(allChannels)) {
        if (msgs.some((m) => m.id === messageId)) {
          channelId = chId;
          break;
        }
      }

      if (currentUserId && channelId) {
        try {
          const senderKeyMsg = await encryptChannelMessage(
            channelId,
            currentUserId,
            e2eeState.localDeviceId,
            content,
            serverId
          );
          if (!isCurrentSession()) return false;
          const ciphertext = JSON.stringify(senderKeyMsg);
          const metadata = JSON.stringify({
            distribution_id: senderKeyMsg.distributionId,
          });

          if (!isCurrentSession()) return false;
          const res = await messageApi.editEncryptedMessage(
            serverId,
            messageId,
            ciphertext,
            e2eeState.localDeviceId,
            metadata
          );
          return isCurrentSession() && res.success;
        } catch (err) {
          if (!isCurrentSession()) return false;
          console.error("[messageStore] E2EE edit encryption failed:", err);
          // Same classification as the send path — see the note there.
          useToastStore
            .getState()
            .addToast(
              "error",
              i18n.t(
                err instanceof SuppressedRosterError
                  ? "e2ee:rosterSuppressed"
                  : "e2ee:encryptionFailed"
              )
            );
          return false;
        }
      }
      // An encrypted edit with no known channel must not fall through to plaintext.
      showEncryptionFailure();
      return false;
    }

    // Only a confirmed non-E2EE origin server may use plaintext.
    const res = await messageApi.editMessage(serverId, messageId, content);
    return isCurrentSession() && res.success;
  },

  deleteMessage: async (messageId, explicitServerId?) => {
    const session = currentMessageSession();
    if (!session) return false;
    const serverId = explicitServerId ?? useServerStore.getState().activeServerId;
    if (!serverId) return false;
    const res = await messageApi.deleteMessage(serverId, messageId);
    return sessionStillCurrent(session) && res.success;
  },

  // ─── Reply Actions ───

  setReplyingTo: (message) => {
    if (!currentMessageSession()) return;
    set({ replyingTo: message });
  },

  /** One-shot: UI scrolls to message and highlights, then resets to null. */
  setScrollToMessageId: (id) => set({ scrollToMessageId: id }),

  // ─── Reactions ───

  /** No optimistic update — WS event will update via handleReactionUpdate. */
  toggleReaction: async (messageId, _channelId, emoji, explicitServerId?) => {
    const session = currentMessageSession();
    if (!session) return;
    const serverId = explicitServerId ?? useServerStore.getState().activeServerId;
    if (!serverId) return;
    await reactionApi.toggleReaction(serverId, messageId, emoji);
  },

  // ─── WebSocket Event Handlers ───

  handleMessageCreate: (message, expectedSession) => {
    const session = currentMessageSession();
    if (!session || (expectedSession && (expectedSession.ownerId !== session.ownerId || expectedSession.authGeneration !== session.authGeneration))) return;
    // Jumped-to window: the tail isn't loaded, so a live insert would be
    // appended after messages that are NOT the newest. Hold it until forward
    // paging reaches the end (fetchNewerMessages merges it).
    if (get().hasMoreAfterByChannel[message.channel_id]) {
      const held = detachedWsMessages.get(message.channel_id) ?? [];
      if (!held.some((m) => m.id === message.id)) {
        detachedWsMessages.set(message.channel_id, [...held, message]);
      }
      return;
    }

    set((state) => {
      // Buffer messages even if channel isn't fetched yet.
      // fetchMessages will merge buffered messages when it completes.
      const channelMessages = state.messagesByChannel[message.channel_id] ?? [];

      // Duplicate guard
      if (channelMessages.some((m) => m.id === message.id)) return state;

      // Clear typing indicator
      const typingUsers = { ...state.typingUsers };
      if (typingUsers[message.channel_id]) {
        typingUsers[message.channel_id] = typingUsers[message.channel_id].filter(
          (u) => u !== message.author?.username
        );
      }

      return {
        messagesByChannel: {
          ...state.messagesByChannel,
          [message.channel_id]: [...channelMessages, message],
        },
        typingUsers,
      };
    });
  },

  handleMessageUpdate: (message, expectedSession) => {
    const session = currentMessageSession();
    if (!session || (expectedSession && (expectedSession.ownerId !== session.ownerId || expectedSession.authGeneration !== session.authGeneration))) return;
    set((state) => ({
      messagesByChannel: updateMessageInRecord(
        state.messagesByChannel, message.channel_id, message
      ),
    }));
  },

  handleMessageDelete: (data) => {
    if (!currentMessageSession()) return;
    const held = detachedWsMessages.get(data.channel_id);
    if (held) detachedWsMessages.set(data.channel_id, held.filter((m) => m.id !== data.id));
    set((state) => ({
      messagesByChannel: deleteMessageFromRecord(
        state.messagesByChannel, data.channel_id, data.id
      ),
      lastDeleted: data,
    }));
  },

  /** Auto-cleared after 5s if no new typing event arrives. */
  handleTypingStart: (channelId, username) => {
    if (!currentMessageSession()) return;
    handleTyping(channelId, username);
  },

  /** Backend sends full reaction list after each toggle — direct replace, no client merge. */
  handleReactionUpdate: (data) => {
    if (!currentMessageSession()) return;
    set((state) => ({
      messagesByChannel: updateReactionInRecord(
        state.messagesByChannel, data.channel_id, data.message_id, data.reactions
      ),
    }));
  },

  handleAuthorUpdate: (userId, patch) => {
    if (!currentMessageSession()) return;
    set((state) => {
      const { updated, changed } = updateAuthorInRecord(
        state.messagesByChannel, userId, patch
      );
      return changed ? { messagesByChannel: updated } : state;
    });
  },
  });
});

// Keep channel-keyed caches and module-level paging buffers private to the
// authenticated session. These subscriptions are synchronous Zustand updates,
// so a late request cannot observe a new auth generation with old rows still
// mounted in the store.
subscribeAuthOwnerChanges(() => syncMessageSession());
subscribeAuthGenerationChanges((generation) => clearMessageCaches(getAuthSessionOwner(), generation));
