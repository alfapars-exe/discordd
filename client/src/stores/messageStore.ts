/**
 * Message Store — Channel message state management.
 */

import { create } from "zustand";
import i18n from "../i18n";
import * as messageApi from "../api/messages";
import * as reactionApi from "../api/reactions";
import { useServerStore } from "./serverStore";
import { useE2EEStore } from "./e2eeStore";
import { useAuthStore } from "./authStore";
import { useReadStateStore } from "./readStateStore";
import { useToastStore } from "./toastStore";
import {
  encryptChannelMessage,
  decryptChannelMessages,
  SuppressedRosterError,
} from "../crypto/channelEncryption";
import { encodePayload } from "../crypto/e2eePayload";
import * as keyStorage from "../crypto/keyStorage";
import type { Message, ReactionGroup } from "../types";
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

type MessageState = {
  /** channelId -> Message[] */
  messagesByChannel: Record<string, Message[]>;
  hasMoreByChannel: Record<string, boolean>;
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
  /** Clear fetch cache — forces re-fetch + re-decrypt (E2EE restore) */
  invalidateFetchCache: () => void;
  /**
   * Drop the fetched-guard only, keeping every loaded message on screen.
   * For WS reconnects, where the window may have missed echoes but is not
   * otherwise wrong — see the action body.
   */
  invalidateFetchedFlags: () => void;
  sendMessage: (channelId: string, content: string, files?: File[], replyToId?: string, serverId?: string) => Promise<boolean>;
  editMessage: (messageId: string, content: string, serverId?: string) => Promise<boolean>;
  deleteMessage: (messageId: string, serverId?: string) => Promise<boolean>;

  // ─── Reply Actions ───
  setReplyingTo: (message: Message | null) => void;
  setScrollToMessageId: (id: string | null) => void;

  // ─── Reactions ───
  toggleReaction: (messageId: string, channelId: string, emoji: string, serverId?: string) => Promise<void>;

  // ─── WS Event Handlers ───
  handleMessageCreate: (message: Message) => void;
  handleMessageUpdate: (message: Message) => void;
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

/** Abort an in-flight fetch for the given channel, if any. */
function abortChannelFetch(channelId: string): void {
  const ctrl = inflightFetches.get(channelId);
  if (ctrl) {
    ctrl.abort();
    inflightFetches.delete(channelId);
  }
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

export const useMessageStore = create<MessageState>((set, get) => ({
  messagesByChannel: {},
  hasMoreByChannel: {},
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
    for (const ctrl of inflightFetches.values()) {
      ctrl.abort();
    }
    inflightFetches.clear();
    fetchedChannels.clear();
    set({ messagesByChannel: {}, hasMoreByChannel: {} });
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
    for (const ctrl of inflightFetches.values()) {
      ctrl.abort();
    }
    inflightFetches.clear();
    fetchedChannels.clear();
  },

  fetchMessages: async (channelId, explicitServerId?) => {
    if (fetchedChannels.has(channelId)) return;

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

    const res = await messageApi.getMessages(serverId, channelId, undefined, DEFAULT_MESSAGE_LIMIT);

    // Aborted while the request was in flight — drop the response. Cache
    // invalidate also aborts, so this branch covers both user-switch and
    // E2EE-rotation cases without polluting messagesByChannel.
    if (controller.signal.aborted) {
      clearLoadingIfOwner();
      return;
    }

    if (res.success && res.data) {
      // Go nil slice -> JSON null; fallback to empty array
      const apiMessages = await decryptChannelMessages(res.data.messages ?? []);

      // Re-check abort after the async decrypt — a fast channel-switch
      // during decryption would otherwise still write stale content. The
      // controller stays registered in inflightFetches until AFTER this
      // check so invalidateFetchCache during the decrypt still reaches it.
      if (controller.signal.aborted) {
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
        const lastMsg = allMessages[allMessages.length - 1];
        useReadStateStore.getState().markAsRead(channelId, lastMsg.id);
      }
    } else {
      inflightFetches.delete(channelId);
      setLoading(false);
    }
  },

  fetchOlderMessages: async (channelId, explicitServerId?) => {
    const messages = get().messagesByChannel[channelId];
    if (!messages || messages.length === 0) return;
    if (!get().hasMoreByChannel[channelId]) return;

    set({ isLoadingMore: true });

    const serverId = explicitServerId ?? useServerStore.getState().activeServerId;
    if (!serverId) { set({ isLoadingMore: false }); return; }

    const beforeId = messages[0].id;
    const res = await messageApi.getMessages(serverId, channelId, beforeId, DEFAULT_MESSAGE_LIMIT);

    if (res.success && res.data) {
      const decrypted = await decryptChannelMessages(res.data.messages ?? []);

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
  },

  sendMessage: async (channelId, content, files, replyToId, explicitServerId?) => {
    const serverId = explicitServerId ?? useServerStore.getState().activeServerId;
    if (!serverId) return false;

    // E2EE: encrypt with Sender Key
    const e2eeState = useE2EEStore.getState();
    const activeServer = useServerStore.getState().activeServer;
    if (activeServer?.e2ee_enabled && e2eeState.initStatus === "ready" && e2eeState.localDeviceId) {
      const currentUserId = useAuthStore.getState().user?.id;
      if (currentUserId) {
        try {
          let encryptedFiles: File[] | undefined;
          let fileMetas: import("../crypto/fileEncryption").EncryptedFileMeta[] | undefined;

          if (files && files.length > 0) {
            const result = await encryptFilesForE2EE(files);
            encryptedFiles = result.files;
            fileMetas = result.metas;
          }

          const plaintext = encodePayload(content, fileMetas);

          const senderKeyMsg = await encryptChannelMessage(
            channelId,
            currentUserId,
            e2eeState.localDeviceId,
            plaintext
          );
          const ciphertext = JSON.stringify(senderKeyMsg);
          const metadata = JSON.stringify({
            distribution_id: senderKeyMsg.distributionId,
          });

          const res = await sendWithRetryAndToast(() =>
            messageApi.sendEncryptedMessage(
              serverId,
              channelId,
              ciphertext,
              e2eeState.localDeviceId!,
              metadata,
              encryptedFiles,
              replyToId
            )
          );
          if (res.success) {
            const created = unwrapSentMessage(res.data);
            if (created) {
              // Insert the 201 body so the sender's own message never depends
              // on the WS echo (a dropped socket loses it). The body carries
              // ciphertext with content:null — inserting it raw would make the
              // later decrypted echo hit the id-dedupe and leave the message
              // permanently unreadable, so overlay the plaintext we just
              // encrypted. handleMessageCreate dedupes by id either way.
              get().handleMessageCreate({ ...created, content, e2ee_file_keys: fileMetas });
              if (content) {
                // Sender-key ratchets can't re-decrypt our own past messages
                // on refetch — persist the plaintext like the echo path does.
                keyStorage.cacheDecryptedMessage({
                  messageId: created.id,
                  channelId,
                  dmChannelId: null,
                  content,
                  timestamp: new Date(created.created_at).getTime(),
                }).catch(() => {});
              }
            }
          }
          return res.success;
        } catch (err) {
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

    // Plaintext fallback
    const res = await sendWithRetryAndToast(() =>
      messageApi.sendMessage(serverId, channelId, content, files, replyToId)
    );
    if (res.success) {
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
    const serverId = explicitServerId ?? useServerStore.getState().activeServerId;
    if (!serverId) return false;

    // E2EE encrypted edit
    const e2eeState = useE2EEStore.getState();
    const activeServerForEdit = useServerStore.getState().activeServer;
    if (activeServerForEdit?.e2ee_enabled && e2eeState.initStatus === "ready" && e2eeState.localDeviceId) {
      const currentUserId = useAuthStore.getState().user?.id;
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
            content
          );
          const ciphertext = JSON.stringify(senderKeyMsg);
          const metadata = JSON.stringify({
            distribution_id: senderKeyMsg.distributionId,
          });

          const res = await messageApi.editEncryptedMessage(
            serverId,
            messageId,
            ciphertext,
            e2eeState.localDeviceId,
            metadata
          );
          return res.success;
        } catch (err) {
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
    }

    // Plaintext fallback
    const res = await messageApi.editMessage(serverId, messageId, content);
    return res.success;
  },

  deleteMessage: async (messageId, explicitServerId?) => {
    const serverId = explicitServerId ?? useServerStore.getState().activeServerId;
    if (!serverId) return false;
    const res = await messageApi.deleteMessage(serverId, messageId);
    return res.success;
  },

  // ─── Reply Actions ───

  setReplyingTo: (message) => set({ replyingTo: message }),

  /** One-shot: UI scrolls to message and highlights, then resets to null. */
  setScrollToMessageId: (id) => set({ scrollToMessageId: id }),

  // ─── Reactions ───

  /** No optimistic update — WS event will update via handleReactionUpdate. */
  toggleReaction: async (messageId, _channelId, emoji, explicitServerId?) => {
    const serverId = explicitServerId ?? useServerStore.getState().activeServerId;
    if (!serverId) return;
    await reactionApi.toggleReaction(serverId, messageId, emoji);
  },

  // ─── WebSocket Event Handlers ───

  handleMessageCreate: (message) => {
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

  handleMessageUpdate: (message) => {
    set((state) => ({
      messagesByChannel: updateMessageInRecord(
        state.messagesByChannel, message.channel_id, message
      ),
    }));
  },

  handleMessageDelete: (data) => {
    set((state) => ({
      messagesByChannel: deleteMessageFromRecord(
        state.messagesByChannel, data.channel_id, data.id
      ),
      lastDeleted: data,
    }));
  },

  /** Auto-cleared after 5s if no new typing event arrives. */
  handleTypingStart: createTypingHandler(set),

  /** Backend sends full reaction list after each toggle — direct replace, no client merge. */
  handleReactionUpdate: (data) => {
    set((state) => ({
      messagesByChannel: updateReactionInRecord(
        state.messagesByChannel, data.channel_id, data.message_id, data.reactions
      ),
    }));
  },

  handleAuthorUpdate: (userId, patch) => {
    set((state) => {
      const { updated, changed } = updateAuthorInRecord(
        state.messagesByChannel, userId, patch
      );
      return changed ? { messagesByChannel: updated } : state;
    });
  },
}));
