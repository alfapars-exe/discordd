import { create } from "zustand";
import i18n from "../i18n";
import { getAuthSessionSnapshot, subscribeAuthGenerationChanges, subscribeAuthOwnerChanges } from "../api/authSessionEvents";
import * as dmApi from "../api/dm";
import type { DMSearchResult } from "../api/dm";
import type { DMChannelWithUser, DMMessage } from "../types";
import { useUIStore } from "./uiStore";
import { useToastStore } from "./toastStore";
import { logToServer } from "../api/clientLog";
import { useE2EEStore } from "./e2eeStore";
import { useAuthStore } from "./authStore";
import {useComposerDraftStore} from "./composerDraftStore";
import {cacheDMMessage} from "../crypto/dmMessageCache";
import {captureDMHistoryVersion,captureDMReceipt,observeDMMessage} from "../crypto/dmMessageVersions";
import {deleteCachedDMMessage} from "../crypto/keyStorage";
import {groupAttachmentKeyIndex} from "../utils/groupAttachmentKeys";
import { registerSpamBatch } from "../utils/registerSpamMessage";
import {
  encryptDMMessage,
  decryptDMMessages,
  pushSentPlaintext,
  discardSentPlaintext,
  cacheEditPlaintext,
  discardEditPlaintext,
} from "../crypto/dmEncryption";
import { encodePayload } from "../crypto/e2eePayload";
import {
  encryptFilesForE2EE,
} from "./shared/messageUtils";
import { sendWithRetryAndToast } from "./shared/sendWithRetry";
import {
  createDMSettingsSlice,
  type DMSettingsSlice,
} from "./slices/dmSettingsSlice";
import {
  createDMWsSlice,
  takeDetachedDMMessages,
  clearDetachedDMMessages,
  beginDMHistoryBuffer,
  bufferDMHistoryEvent,
  type DMWsSlice,
} from "./slices/dmWsSlice";

const EMPTY_CHANNELS: DMChannelWithUser[] = [];
const EMPTY_MESSAGES: DMMessage[] = [];
const EMPTY_STRINGS: string[] = [];
let dmChannelListRequest=0;
let dmChannelMetadataRevision = 0;

type DMAuthScope = { ownerId: string | null; authGeneration: number };
type DMSendContext = { ownerId: string; authGeneration: number; isCurrent?: () => boolean };
const initialDMAuthScope = getAuthSessionSnapshot();

function clearDMAuthScope(scope: DMAuthScope): void {
  dmChannelListRequest++;
  dmChannelMetadataRevision++;
  for (const controller of dmInflightFetches.values()) controller.abort();
  dmInflightFetches.clear();
  dmInflightNewerFetches.clear();
  dmAroundPending.clear();
  clearDetachedDMMessages();
  useDMStore.setState({
    ownerId: scope.ownerId, authGeneration: scope.authGeneration,
    channels: EMPTY_CHANNELS, selectedDMId: null, messagesByChannel: {},
    hasMoreByChannel: {}, hasMoreAfterByChannel: {}, isLoading: false,
    isLoadingMessages: false, dmUnreadCounts: {}, pendingSearchChannelId: null,
    replyingTo: null, scrollToMessageId: null, typingUsers: {}, lastDeletedDM: null,
  });
}

function currentDMAuthScope(): DMAuthScope | null {
  const snapshot = getAuthSessionSnapshot();
  const state = useDMStore.getState();
  if (state.ownerId !== snapshot.ownerId || state.authGeneration !== snapshot.generation) {
    clearDMAuthScope({ ownerId: snapshot.ownerId, authGeneration: snapshot.generation });
  }
  const authenticatedOwner = useAuthStore.getState().user?.id ?? null;
  return snapshot.ownerId && snapshot.ownerId === authenticatedOwner
    ? { ownerId: snapshot.ownerId, authGeneration: snapshot.generation }
    : null;
}

function dmAuthScopeIsCurrent(scope: DMAuthScope): boolean {
  if (!scope.ownerId) return false;
  const snapshot = getAuthSessionSnapshot();
  const state = useDMStore.getState();
  return snapshot.ownerId === scope.ownerId && snapshot.generation === scope.authGeneration
    && useAuthStore.getState().user?.id === scope.ownerId
    && state.ownerId === scope.ownerId && state.authGeneration === scope.authGeneration;
}

function captureDMReadContext(): () => boolean {
  const scope = currentDMAuthScope();
  const draftGeneration = useComposerDraftStore.getState().generation;
  const deviceId = useE2EEStore.getState().localDeviceId;
  return () => !!scope && dmAuthScopeIsCurrent(scope)
    && useComposerDraftStore.getState().generation === draftGeneration
    && useE2EEStore.getState().localDeviceId === deviceId;
}

function reportDMHistoryFailure(): void {
  useToastStore.getState().addToast("error", i18n.t("dm:historyLoadFailed"));
}

/**
 * Per-channel AbortController for in-flight fetchMessages calls. When the
 * user switches DMs (or this store's invalidateFetchCache is called), any
 * pending request for the abandoned channel is aborted so its late setState
 * can't trample the active channel's view.
 *
 * Keyed by channelId so two channels fetching concurrently don't cancel
 * each other — only a SECOND fetch for the SAME channel aborts the first.
 */
const dmInflightFetches = new Map<string, AbortController>();

/** DM channels with a forward (?after=) page in flight — one at a time each. */
const dmInflightNewerFetches = new Map<string, symbol>();

/**
 * DM channels with a jump (fetchMessagesAround) in flight, keyed to the
 * owning controller. Claimed synchronously before the first await so the
 * mount-time fetchMessages of the freshly opened DM tab — which would abort
 * the jump via abortDMChannelFetch — skips the channel.
 */
const dmAroundPending = new Map<string, AbortController>();

/** Abort an in-flight fetch for the given DM channel, if any. */
function abortDMChannelFetch(channelId: string): void {
  const ctrl = dmInflightFetches.get(channelId);
  if (ctrl) {
    ctrl.abort();
    dmInflightFetches.delete(channelId);
  }
}

type DMCoreState = {
  /** Account/session that owns all DM channels and message caches below. */
  ownerId: string | null;
  authGeneration: number;
  channels: DMChannelWithUser[];
  selectedDMId: string | null;
  messagesByChannel: Record<string, DMMessage[]>;
  hasMoreByChannel: Record<string, boolean>;
  /**
   * channelId -> newer messages exist AFTER the loaded window (only after a
   * fetchMessagesAround jump). While set, live inserts are dropped by
   * handleDMMessageCreate and the list offers "jump to present".
   */
  hasMoreAfterByChannel: Record<string, boolean>;
  isLoading: boolean;
  isLoadingMessages: boolean;

  replyingTo: DMMessage | null;
  scrollToMessageId: string | null;

  typingUsers: Record<string, string[]>;

  fetchChannels: () => Promise<boolean>;
  selectDM: (channelId: string | null) => void;
  createOrGetChannel: (userId: string) => Promise<string | null>;
  /** Self-DM ("My Notes") channel id — created server-side on first use. */
  ensureSelfChannel: () => Promise<string | null>;
  fetchMessages: (channelId: string) => Promise<void>;
  fetchOlderMessages: (channelId: string) => Promise<void>;
  /**
   * Replace the channel's window with one centred on `messageId`. Resolves
   * false when the message no longer exists. Does not touch unread state.
   */
  fetchMessagesAround: (channelId: string, messageId: string, options?: {isCurrent?:()=>boolean}) => Promise<boolean>;
  /** Append the next page after the window's last message (forward paging). */
  fetchNewerMessages: (channelId: string) => Promise<void>;
  /** Drop a jumped-to window and reload the channel tail. */
  jumpToPresent: (channelId: string) => void;
  sendMessage: (channelId: string, content: string, files?: File[], replyToId?: string, context?: DMSendContext) => Promise<boolean>;
  editMessage: (messageId: string, content: string) => Promise<boolean>;
  deleteMessage: (messageId: string) => Promise<boolean>;

  setReplyingTo: (message: DMMessage | null) => void;
  setScrollToMessageId: (id: string | null) => void;

  toggleReaction: (messageId: string, channelId: string, emoji: string) => Promise<void>;

  pinMessage: (channelId: string, messageId: string) => Promise<void>;
  unpinMessage: (channelId: string, messageId: string) => Promise<void>;
  getPinnedMessages: (channelId: string) => Promise<DMMessage[]>;

  searchMessages: (channelId: string, query: string, limit?: number, offset?: number) => Promise<DMSearchResult>;

  acceptDMRequest: (channelId: string) => Promise<void>;
  declineDMRequest: (channelId: string) => Promise<void>;

  toggleE2EE: (channelId: string, enabled: boolean) => Promise<boolean>;

  getMessagesForChannel: (channelId: string) => DMMessage[];
  getTypingUsers: (channelId: string) => string[];
  invalidateMessages: (channelId: string) => void;
  invalidateFetchCache: () => void;
};

export type DMStore = DMCoreState & DMSettingsSlice & DMWsSlice;

export const useDMStore = create<DMStore>((set, get, store) => ({
  ...createDMSettingsSlice(set, get, store),
  ...createDMWsSlice(set, get, store),

  ownerId: initialDMAuthScope.ownerId,
  authGeneration: initialDMAuthScope.generation,
  channels: EMPTY_CHANNELS,
  selectedDMId: null,
  messagesByChannel: {},
  hasMoreByChannel: {},
  hasMoreAfterByChannel: {},
  isLoading: false,
  isLoadingMessages: false,
  replyingTo: null,
  scrollToMessageId: null,
  typingUsers: {},

  fetchChannels: async () => {
    const request = ++dmChannelListRequest;
    const scope = currentDMAuthScope();
    const generation = useComposerDraftStore.getState().generation;
    const metadataRevision = dmChannelMetadataRevision;
    const isCurrent = () => request === dmChannelListRequest && Boolean(scope)
      && dmAuthScopeIsCurrent(scope!)
      && useComposerDraftStore.getState().generation === generation;
    if (!scope) { set({ isLoading: false }); return false; }
    set({ isLoading: true });
    try {
      const res = await dmApi.listDMChannels({ isCurrent, timeoutMs: 15_000 });
      if (!isCurrent()) return false;
      if (res.success && res.data) {
        if (metadataRevision !== dmChannelMetadataRevision) {
          // A WS/read event or another local channel mutation landed while
          // this snapshot was in flight. The event path is newer than this
          // list response, so retain the whole current metadata snapshot
          // instead of mixing stale unread counts/previews into it.
          set({ isLoading: false });
          return true;
        }
        // Seed unread counts from the server's per-user read cursor so a fresh
        // tab (or a reconnect) shows what was missed instead of starting at 0.
        const dmUnreadCounts: Record<string, number> = {};
        for (const ch of res.data) {
          if (ch.unread_count > 0) dmUnreadCounts[ch.id] = ch.unread_count;
        }
        set({ channels: res.data, dmUnreadCounts, isLoading: false });
        return true;
      }
      set({ isLoading: false });
      return false;
    } catch {
      if (isCurrent()) set({ isLoading: false });
      return false;
    }
  },

  selectDM: (channelId) => {
    if (!currentDMAuthScope()) return;
    set({ selectedDMId: channelId });
  },

  createOrGetChannel: async (userId) => {
    const current = captureDMReadContext();
    if (!current()) return null;
    const res = await dmApi.createDMChannel(userId, { isCurrent: current, timeoutMs: 15_000 });
    if (!current()) return null;
    if (res.success && res.data) {
      set((state) => {
        const exists = state.channels.some((ch) => ch.id === res.data!.id);
        if (exists) return state;
        return { channels: [res.data!, ...state.channels] };
      });
      return res.data.id;
    }
    return null;
  },

  ensureSelfChannel: async () => {
    const current = captureDMReadContext();
    if (!current()) return null;
    const res = await dmApi.getOrCreateSelfDMChannel({ isCurrent: current, timeoutMs: 15_000 });
    if (!current()) return null;
    if (res.success && res.data) {
      set((state) => {
        const exists = state.channels.some((ch) => ch.id === res.data!.id);
        if (exists) return state;
        return { channels: [res.data!, ...state.channels] };
      });
      return res.data.id;
    }
    return null;
  },

  fetchMessages: async (channelId) => {
    const contextCurrent = captureDMReadContext();
    if (!contextCurrent()) return;
    // A jump in flight owns the channel — see dmAroundPending.
    if (get().messagesByChannel[channelId] || dmAroundPending.has(channelId)) return;

    const e2eeStatus = useE2EEStore.getState().initStatus;
    if (e2eeStatus !== "ready") return;

    // If a previous fetch for this channel is still in flight, cancel it.
    // The two main triggers: user spam-clicking DMs, and E2EE store
    // refreshing then re-triggering a fetch. Either way we don't want the
    // late response to clobber whatever the user is now looking at.
    abortDMChannelFetch(channelId);
    const controller = new AbortController();
    dmInflightFetches.set(channelId, controller);
    const current = () => !controller.signal.aborted && contextCurrent();

    set({ isLoadingMessages: true });

    const historyVersion = captureDMHistoryVersion(channelId);
    const historyBuffer = beginDMHistoryBuffer(channelId);
    try {
    const res = await dmApi.getDMMessages(channelId, undefined, 50, {isCurrent:current, signal:controller.signal, timeoutMs:15000});

    // Aborted while the request was in flight — drop the response. Cache
    // invalidate also aborts, so this branch covers both user-switch and
    // E2EE-rotation cases without polluting messagesByChannel.
    if (!current()) {
      return;
    }

    if (res.success && res.data) {
      const decrypted = await decryptDMMessages(res.data!.messages ?? [], current, historyVersion.current);
      const messages = decrypted.filter(historyVersion.current);
      const positions = new Map((res.data.messages??[]).map((message,index)=>[message.id,index]));
      if (current()) void registerSpamBatch(messages, "dm", channelId);

      // Re-check abort after the async decrypt — a fast DM-switch during
      // decryption would otherwise still write stale content.
      if (!current()) return;

      set((state) => ({
        messagesByChannel: {
          ...state.messagesByChannel,
          [channelId]: [...new Map([
            ...messages,
            ...(state.messagesByChannel[channelId]??[]).filter(message=>!historyVersion.current(message)&&!historyVersion.deleted(message)),
            ...historyBuffer.read().filter(message=>!historyVersion.current(message)&&!historyVersion.deleted(message)),
          ].map(message=>[message.id,message])).values()].map(historyBuffer.apply).sort((a,b)=>a.created_at.localeCompare(b.created_at)||(positions.get(a.id)??Number.MAX_SAFE_INTEGER)-(positions.get(b.id)??Number.MAX_SAFE_INTEGER)),
        },
        hasMoreByChannel: {
          ...state.hasMoreByChannel,
          [channelId]: res.data!.has_more,
        },
      }));
    } else {
      reportDMHistoryFailure();
    }
    } catch {
      if (current()) reportDMHistoryFailure();
    } finally {
      historyBuffer.release();
      if (dmInflightFetches.get(channelId) === controller) {
        dmInflightFetches.delete(channelId);
        if (current()) set({isLoadingMessages:dmInflightFetches.size > 0});
      }
    }
  },

  fetchOlderMessages: async (channelId) => {
    const contextCurrent = captureDMReadContext();
    if (!contextCurrent()) return;
    const messages = get().messagesByChannel[channelId];
    if (!messages || messages.length === 0) return;
    if (!get().hasMoreByChannel[channelId]) return;

    const beforeId = messages[0].id;
    const historyVersion = captureDMHistoryVersion(channelId);
    const historyBuffer = beginDMHistoryBuffer(channelId);
    const current = () => contextCurrent() && get().messagesByChannel[channelId] === messages;
    try {
    const res = await dmApi.getDMMessages(channelId, beforeId, 50, {isCurrent:current, timeoutMs:15000});
    if (!current()) return;
    if (res.success && res.data) {
      const decrypted = (await decryptDMMessages(res.data!.messages, current, historyVersion.current)).filter(historyVersion.current);
      if (!current()) return;
      void registerSpamBatch(decrypted, "dm", channelId);

      set((state) => ({
        messagesByChannel: {
          ...state.messagesByChannel,
          [channelId]: [...decrypted, ...state.messagesByChannel[channelId]].map(historyBuffer.apply),
        },
        hasMoreByChannel: {
          ...state.hasMoreByChannel,
          [channelId]: res.data!.has_more,
        },
      }));
    } else reportDMHistoryFailure();
    } catch {
      if (current()) reportDMHistoryFailure();
    } finally {
      historyBuffer.release();
    }
  },

  fetchMessagesAround: async (channelId, messageId, options) => {
    const contextCurrent = captureDMReadContext();
    const callerCurrent = () => options?.isCurrent?.() !== false;
    if (!contextCurrent() || !callerCurrent()) return false;
    // Same abort discipline as fetchMessages: the tail fetch DMChat kicks
    // off on mount must not land after this window and replace it.
    abortDMChannelFetch(channelId);
    const controller = new AbortController();
    dmInflightFetches.set(channelId, controller);
    const current = () => contextCurrent() && !controller.signal.aborted && callerCurrent();
    // Claim BEFORE the first await — see dmAroundPending.
    dmAroundPending.set(channelId, controller);
    const release = () => {
      if (dmAroundPending.get(channelId) === controller) dmAroundPending.delete(channelId);
    };
    set({ isLoadingMessages: true });

    const historyVersion = captureDMHistoryVersion(channelId);
    const historyBuffer = beginDMHistoryBuffer(channelId);
    try {
    const res = await dmApi.getDMMessagesAround(channelId, messageId, 50, {isCurrent:current, signal:controller.signal, timeoutMs:15000});
    if (!current()) {
      release();
      return false;
    }

    if ((!res.success || !res.data) && res.status !== 404) {
      reportDMHistoryFailure();
      return false;
    }
    const page = res.success ? res.data : undefined;
    const raw = page?.messages ?? [];
    if (!page || !raw.some((m) => m.id === messageId)) {
      // Target gone — keep any existing window; if there is none (the claim
      // made the tab's mount fetch skip), load the tail now.
      dmInflightFetches.delete(channelId);
      release();
      set({ isLoadingMessages: dmInflightFetches.size > 0 });
      void get().fetchMessages(channelId);
      return false;
    }

    const decrypted = (await decryptDMMessages(raw, current, historyVersion.current)).filter(historyVersion.current);
    if (current()) void registerSpamBatch(decrypted, "dm", channelId);
    if (!current()) {
      release();
      return false;
    }
    const rawIds = new Set(raw.map(message=>message.id));
    const positions = new Map(raw.map((message,index)=>[message.id,index]));
    const retained = [...(get().messagesByChannel[channelId]??[]),...historyBuffer.read()].filter(message=>rawIds.has(message.id)&&!historyVersion.current(message)&&!historyVersion.deleted(message));
    const windowMessages = [...new Map([...decrypted,...retained].map(message=>[message.id,message])).values()].map(historyBuffer.apply)
      .sort((a,b)=>a.created_at.localeCompare(b.created_at)||(positions.get(a.id)??Number.MAX_SAFE_INTEGER)-(positions.get(b.id)??Number.MAX_SAFE_INTEGER));
    if (!windowMessages.some(message=>message.id===messageId)) return false;
    clearDetachedDMMessages(channelId);

    set((state) => ({
      messagesByChannel: { ...state.messagesByChannel, [channelId]: windowMessages },
      hasMoreByChannel: { ...state.hasMoreByChannel, [channelId]: page.has_more },
      hasMoreAfterByChannel: {
        ...state.hasMoreAfterByChannel,
        [channelId]: page.has_more_after ?? false,
      },
    }));
    return true;
    } catch {
      if (current()) reportDMHistoryFailure();
      return false;
    } finally {
      historyBuffer.release();
      release();
      if (dmInflightFetches.get(channelId) === controller) {
        dmInflightFetches.delete(channelId);
        if (contextCurrent()) set({isLoadingMessages:dmInflightFetches.size > 0});
      }
    }
  },

  fetchNewerMessages: async (channelId) => {
    const contextCurrent = captureDMReadContext();
    if (!contextCurrent()) return;
    const messages = get().messagesByChannel[channelId];
    if (!messages || messages.length === 0) return;
    if (!get().hasMoreAfterByChannel[channelId]) return;
    if (dmInflightNewerFetches.has(channelId)) return;

    const request = Symbol();
    dmInflightNewerFetches.set(channelId, request);
    const current = () => contextCurrent() && dmInflightNewerFetches.get(channelId) === request &&
      get().messagesByChannel[channelId] === messages;
    const afterId = messages[messages.length - 1].id;
    const historyVersion = captureDMHistoryVersion(channelId);
    const historyBuffer = beginDMHistoryBuffer(channelId);
    try {
      const res = await dmApi.getDMMessagesAfter(channelId, afterId, 50, {isCurrent:current, timeoutMs:15000});
      if (!current()) return;
      if (!res.success || !res.data) { reportDMHistoryFailure(); return; }
      const decrypted = (await decryptDMMessages(res.data.messages ?? [], current, historyVersion.current)).filter(historyVersion.current);
      if (!current()) return;
      void registerSpamBatch(decrypted, "dm", channelId);
      const hasMoreAfter = res.data.has_more_after ?? false;
      // Reached the tail: merge live messages held back while detached.
      const held = hasMoreAfter ? [] : takeDetachedDMMessages(channelId);

      set((state) => {
        const current = state.messagesByChannel[channelId] ?? [];
        const seen = new Set(current.map((m) => m.id));
        const appended: DMMessage[] = [];
        for (const m of [...decrypted, ...held]) {
          if (seen.has(m.id)) continue;
          seen.add(m.id);
          appended.push(m);
        }
        return {
          messagesByChannel: {
            ...state.messagesByChannel,
            [channelId]: [...current, ...appended].map(historyBuffer.apply),
          },
          hasMoreAfterByChannel: { ...state.hasMoreAfterByChannel, [channelId]: hasMoreAfter },
        };
      });
    } catch {
      if (current()) reportDMHistoryFailure();
    } finally {
      historyBuffer.release();
      if (dmInflightNewerFetches.get(channelId) === request) dmInflightNewerFetches.delete(channelId);
    }
  },

  jumpToPresent: (channelId) => {
    dmAroundPending.delete(channelId);
    clearDetachedDMMessages(channelId);
    get().invalidateMessages(channelId);
    set((state) => ({
      hasMoreAfterByChannel: { ...state.hasMoreAfterByChannel, [channelId]: false },
    }));
    void get().fetchMessages(channelId);
  },

  sendMessage: async (channelId, content, files, replyToId, context) => {
    const scope = currentDMAuthScope();
    const owner=scope?.ownerId;
    const sessionCurrent=captureDMReadContext();
    const channel=get().channels.find(item=>item.id===channelId),deviceId=useE2EEStore.getState().localDeviceId;
    const callerContextCurrent = () => !context || (context.ownerId === scope?.ownerId
      && context.authGeneration === scope?.authGeneration && context.isCurrent?.() !== false);
    const isCurrent=()=>Boolean(owner&&scope)&&dmAuthScopeIsCurrent(scope!)&&sessionCurrent()&&callerContextCurrent()
      &&get().channels.some(item=>item.id===channelId&&item.other_user.id===channel?.other_user.id&&item.e2ee_enabled===channel?.e2ee_enabled)
      &&(!channel?.e2ee_enabled||useE2EEStore.getState().localDeviceId===deviceId);
    if(!owner||!channel)return false;
    if(channel.e2ee_enabled&&(useE2EEStore.getState().initStatus!=="ready"||!deviceId)){
      useToastStore.getState().addToast("error",i18n.t("e2ee:encryptionFailed"));return false;
    }
    const ok = await (async (): Promise<boolean> => {
    const e2eeState = useE2EEStore.getState();

    const dmChannel = get().channels.find((ch) => ch.id === channelId);
    if (dmChannel?.e2ee_enabled && e2eeState.initStatus === "ready" && e2eeState.localDeviceId) {
      const channel = dmChannel;
      const currentUserId = useAuthStore.getState().user?.id;

      if (channel && currentUserId) {
        // Only this send's own queue entry may be discarded on failure; if
        // encryption threw before the push, discarding would drop the entry of
        // another in-flight send to the same channel.
        let queuedPayload:Parameters<typeof pushSentPlaintext>[1]|undefined;
        try {
          let encryptedFiles: File[] | undefined;
          let fileMetas: import("../crypto/fileEncryption").EncryptedFileMeta[] | undefined;

          if (files && files.length > 0) {
            const result = await encryptFilesForE2EE(files);
            if(!isCurrent())return false;
            encryptedFiles = result.files;
            fileMetas = result.metas;
          }

          const plaintext = encodePayload(content, fileMetas);

          const envelopes = await encryptDMMessage(
            currentUserId,
            channel.other_user.id,
            e2eeState.localDeviceId,
            plaintext
          );
          if(!isCurrent())return false;

          const ciphertext = JSON.stringify(envelopes);
          // Distinguishes local-only/self-DM sends whose envelope arrays may
          // both be empty. Not an idempotency key or authorization claim.
          const metadata = JSON.stringify({client_send_id:crypto.randomUUID()});

          queuedPayload={content,file_keys:fileMetas};
          pushSentPlaintext(channelId, queuedPayload,{ciphertext,metadata});

          const claimReceipt = captureDMReceipt(channelId);
          const res = await sendWithRetryAndToast(() =>
            dmApi.sendEncryptedDMMessage(
              channelId,
              ciphertext,
              e2eeState.localDeviceId!,
              metadata,
              encryptedFiles,
              replyToId,
              {isCurrent,timeoutMs:60_000}
            )
          ,{isCurrent});

          if(!isCurrent()){discardSentPlaintext(channelId,queuedPayload);return false}

          if (res.success && res.data&&res.data.dm_channel_id===channelId&&res.data.user_id===owner&&res.data.sender_device_id===e2eeState.localDeviceId&&res.data.ciphertext===ciphertext&&res.data.e2ee_metadata===metadata) {
            const receiptCurrent = claimReceipt(res.data);
            if (!receiptCurrent) discardSentPlaintext(channelId,queuedPayload);
            else bufferDMHistoryEvent({...res.data,content:queuedPayload.content,e2ee_file_keys:queuedPayload.file_keys});
            try {
              if (receiptCurrent) await cacheDMMessage(res.data,queuedPayload,()=>isCurrent()&&receiptCurrent());
            } catch {
              /* IndexedDB optional */
            }
          }

          if (!res.success) {
            discardSentPlaintext(channelId,queuedPayload);
          }

          return isCurrent()&&res.success;
        } catch (err) {
          if (queuedPayload) discardSentPlaintext(channelId,queuedPayload);
          if(!isCurrent())return false;
          console.error("[dmStore] E2EE encrypt failed:", err);

          const errMsg = err instanceof Error ? err.message : "";
          // Event + reason only — never the message content. channelId + the
          // error code help diagnose "my DM won't send" reports.
          logToServer("warn", "dm_send_failed", {
            channelId,
            reason: errMsg || "encrypt_error",
            hadFiles: !!(files && files.length),
          });
          useToastStore.getState().addToast("error", i18n.t("e2ee:encryptionFailed"));
          return false;
        }
      }
    }

    const res = await sendWithRetryAndToast(() =>
      dmApi.sendDMMessage(channelId, content, files, replyToId,{isCurrent,timeoutMs:60_000})
    ,{isCurrent});
    return isCurrent()&&res.success;
    })();
    // Sent from a jumped-to window: DMs have no local insert (the WS echo is
    // the only path, and it is held back while detached), so return to the
    // tail AFTER the POST persisted — the refetch then includes the message.
    if (ok && isCurrent() && get().hasMoreAfterByChannel[channelId]) get().jumpToPresent(channelId);
    return isCurrent()&&ok;
  },

  editMessage: async (messageId, content) => {
    const state=get(),scope=currentDMAuthScope(),owner=scope?.ownerId,sessionCurrent=captureDMReadContext();
    const original=Object.values(state.messagesByChannel).flat().find(message=>message.id===messageId);
    const channel=state.channels.find(item=>item.id===original?.dm_channel_id),device=useE2EEStore.getState().localDeviceId;
    if(!owner||!original||original.user_id!==owner||!channel)return false;
    const current=()=>Boolean(scope)&&dmAuthScopeIsCurrent(scope!)&&sessionCurrent()
      &&get().channels.some(item=>item.id===channel.id&&item.other_user.id===channel.other_user.id&&item.e2ee_enabled===channel.e2ee_enabled)
      &&(!channel.e2ee_enabled||useE2EEStore.getState().localDeviceId===device);
    if(!channel.e2ee_enabled){const res=await dmApi.editDMMessage(messageId,content,{isCurrent:current});return current()&&res.success}
    const payload={content,file_keys:original.e2ee_file_keys};
    const hasAttachmentKeys=(original.attachments??[]).every((attachment,position)=>{const index=groupAttachmentKeyIndex(attachment,position);return index!==undefined&&Boolean(payload.file_keys?.[index])});
    if(!device||useE2EEStore.getState().initStatus!=="ready"||!hasAttachmentKeys){
      useToastStore.getState().addToast("error",i18n.t("e2ee:encryptionFailed"));return false;
    }
    try{
      const envelopes=await encryptDMMessage(owner,channel.other_user.id,device,encodePayload(content,payload.file_keys));
      if(!current())return false;
      const ciphertext=JSON.stringify(envelopes),metadata=JSON.stringify({client_send_id:crypto.randomUUID()});
      cacheEditPlaintext(messageId,payload,{ciphertext,metadata});
      const claimReceipt = captureDMReceipt(channel.id);
      const res=await dmApi.editEncryptedDMMessage(messageId,ciphertext,device,metadata,{isCurrent:current});
      if(!current()){discardEditPlaintext(messageId,payload);return false}
      if(res.success&&res.data&&res.data.id===messageId&&res.data.dm_channel_id===channel.id&&res.data.user_id===owner&&res.data.sender_device_id===device&&res.data.ciphertext===ciphertext&&res.data.e2ee_metadata===metadata){
        const receiptCurrent=claimReceipt(res.data);
        if(!receiptCurrent)discardEditPlaintext(messageId,payload);
        else bufferDMHistoryEvent({...res.data,content:payload.content,e2ee_file_keys:payload.file_keys});
        try{if(receiptCurrent)await cacheDMMessage(res.data,payload,()=>current()&&receiptCurrent())}catch{/* optional local cache; the edit already committed */}
      }
      if(!res.success)discardEditPlaintext(messageId,payload);
      return current()&&res.success;
    }catch{
      discardEditPlaintext(messageId,payload);if(current())useToastStore.getState().addToast("error",i18n.t("e2ee:encryptionFailed"));return false;
    }
  },

  deleteMessage: async (messageId) => {
    const current=captureDMReadContext();if(!current())return false;
    const original=Object.values(get().messagesByChannel).flat().find(message=>message.id===messageId);
    try {
      const res=await dmApi.deleteDMMessage(messageId,{isCurrent:current,timeoutMs:15000});
      if(!current()||!res.success)return false;
      const receipt=res.data;
      const hasScope=receipt?.id!==undefined||receipt?.dm_channel_id!==undefined;
      if(hasScope&&(receipt?.id!==messageId||typeof receipt.dm_channel_id!=="string"||!receipt.dm_channel_id))return false;
      const channelId=receipt?.dm_channel_id??original?.dm_channel_id;
      if(!channelId)return true; // Older servers can omit scope for an unloaded message.
      if(original&&channelId!==original.dm_channel_id)return false;
      const deletionCurrent=observeDMMessage(channelId,messageId,true);
      get().handleDMMessageDelete({id:messageId,dm_channel_id:channelId});
      try{await deleteCachedDMMessage(messageId,channelId,()=>current()&&deletionCurrent());}
      catch{if(current())console.warn("[dmStore] deleted-message cache cleanup failed");}
      return current();
    }catch{return false;}
  },

  setReplyingTo: (message) => set({ replyingTo: message }),
  setScrollToMessageId: (id) => set({ scrollToMessageId: id }),

  toggleReaction: async (messageId, _channelId, emoji) => {
    await dmApi.toggleDMReaction(messageId, emoji);
  },

  pinMessage: async (_channelId, messageId) => {
    await dmApi.pinDMMessage(messageId);
  },

  unpinMessage: async (_channelId, messageId) => {
    await dmApi.unpinDMMessage(messageId);
  },

  getPinnedMessages: async (channelId) => {
    const res = await dmApi.getDMPinnedMessages(channelId);
    if (res.success && res.data) {
      return res.data;
    }
    return [];
  },

  searchMessages: async (channelId, query, limit = 25, offset = 0) => {
    const res = await dmApi.searchDMMessages(channelId, query, limit, offset);
    if (res.success && res.data) {
      return res.data;
    }
    return { messages: [], total_count: 0 };
  },

  acceptDMRequest: async (channelId) => {
    const res = await dmApi.acceptDMRequest(channelId);
    if (res.success) {
      set((state) => ({
        channels: state.channels.map((ch) =>
          ch.id === channelId ? { ...ch, status: "accepted" as const, initiated_by: null } : ch
        ),
      }));
    }
  },

  declineDMRequest: async (channelId) => {
    const res = await dmApi.declineDMRequest(channelId);
    if (res.success) {
      useUIStore.getState().closeDMTab(channelId);
      set((state) => ({
        channels: state.channels.filter((ch) => ch.id !== channelId),
        selectedDMId: state.selectedDMId === channelId ? null : state.selectedDMId,
      }));
    }
  },

  toggleE2EE: async (channelId, enabled) => {
    const res = await dmApi.toggleDME2EE(channelId, enabled);
    if (res.success && res.data) {
      set((state) => ({
        channels: state.channels.map((ch) =>
          ch.id === channelId ? { ...ch, e2ee_enabled: enabled } : ch
        ),
      }));
      if (enabled) {
        useE2EEStore.getState().checkAndPromptRecovery();
      }
    }
    return res.success;
  },

  getMessagesForChannel: (channelId) => {
    return get().messagesByChannel[channelId] ?? EMPTY_MESSAGES;
  },

  getTypingUsers: (channelId) => {
    return get().typingUsers[channelId] ?? EMPTY_STRINGS;
  },

  invalidateMessages: (channelId) => {
    // Abort any in-flight fetch for this channel so a late response can't
    // re-populate the entry we're about to clear. An aborted jump gives up
    // its claim immediately so the caller's follow-up fetchMessages runs.
    abortDMChannelFetch(channelId);
    dmAroundPending.delete(channelId);
    set((state) => {
      const { [channelId]: _, ...rest } = state.messagesByChannel;
      const { [channelId]: __, ...restMore } = state.hasMoreByChannel;
      return { messagesByChannel: rest, hasMoreByChannel: restMore };
    });
  },

  invalidateFetchCache: () => {
    dmChannelListRequest++;
    // Cancel any in-flight fetches; their late completion would re-populate
    // messagesByChannel with stale ciphertext encrypted against the
    // pre-restore E2EE state.
    for (const ctrl of dmInflightFetches.values()) {
      ctrl.abort();
    }
    dmInflightFetches.clear();
    dmInflightNewerFetches.clear();
    dmAroundPending.clear();
    clearDetachedDMMessages();
    set({ messagesByChannel: {}, hasMoreByChannel: {}, hasMoreAfterByChannel: {},isLoading:false,isLoadingMessages:false });
  },
}));

// Channel-list responses are snapshots. Fence a response if *any* newer
// channel/unread state was committed while it was outstanding. Watching the
// state references here covers WS handlers and local read/settings actions
// without making every mutation path maintain a separate revision counter.
useDMStore.subscribe((state, previous) => {
  if (state.channels !== previous.channels || state.dmUnreadCounts !== previous.dmUnreadCounts) {
    dmChannelMetadataRevision++;
  }
});

subscribeAuthOwnerChanges((ownerId) => clearDMAuthScope({ ownerId, authGeneration: getAuthSessionSnapshot().generation }));
subscribeAuthGenerationChanges((authGeneration) => clearDMAuthScope({ ownerId: getAuthSessionSnapshot().ownerId, authGeneration }));
