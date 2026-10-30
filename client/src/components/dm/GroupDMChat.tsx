import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import { useConversationCommand } from "../../hooks/useConversationCommand";
import { useConversationPageShortcut } from "../../hooks/useConversationPageShortcut";
import { useFocusComposerOnTyping } from "../../hooks/useFocusComposerOnTyping";
import { useIsTouch } from "../../hooks/useMediaQuery";
import { useTranslation } from "react-i18next";
import { useAuthStore } from "../../stores/authStore";
import { useE2EEStore } from "../../stores/e2eeStore";
import { useFriendStore } from "../../stores/friendStore";
import { useGroupDMStore,type GroupUploadRecovery } from "../../stores/groupDMStore";
import { useUIStore } from "../../stores/uiStore";
import Avatar from "../shared/Avatar";
import ReportModal from "../shared/ReportModal";
import type { GroupDMMessage } from "../../types/groupDM";
import { useGroupCallStore } from "../../stores/groupCallStore";
import EncryptedAttachment from "../chat/EncryptedAttachment";
import UnclassifiedMediaGate from "../chat/UnclassifiedMediaGate";
import GroupSpamGate from "../chat/GroupSpamGate";
import SpamPreview from "../chat/SpamPreview";
import { formatDateTime } from "../../utils/dateFormat";
import { useConfirm } from "../../hooks/useConfirm";
import { useVoiceShortcutAction } from "../../hooks/useVoiceShortcutAction";
import { getAuthGeneration } from "../../api/client";
import type { MessageAction } from "../chat/messageActionRegistry";
import { copyToClipboard, MAX_FILES } from "../../utils/constants";
import { speakMessage } from "../../utils/textToSpeech";
import { useToastStore } from "../../stores/toastStore";
import { composerKey,EMPTY_DRAFT,useComposerDraftStore } from "../../stores/composerDraftStore";
import { groupAttachmentKey } from "../../utils/groupAttachmentKeys";
import ForwardMessageModal from "../chat/ForwardMessageModal";
import JumpToPresentPill from "../chat/JumpToPresentPill";
import type {ForwardableMessage} from "../chat/forwardMessageContent";
import { validateFiles } from "../../utils/fileValidation";
import { useAttachmentRejectionToast } from "../../hooks/useAttachmentRejectionToast";
import EmojiPicker from "../shared/EmojiPicker";
import GifPicker from "../shared/GifPicker";
import StickerPicker from "../shared/StickerPicker";
import GroupDMMessageBody from "./GroupDMMessageBody";
import GroupDMPinsPanel from "./GroupDMPinsPanel";
import { pinCurrentGroupDMMessage } from "../../utils/groupDMPins";
const EMPTY_GROUP_MESSAGES:GroupDMMessage[]=[];
const EMPTY_UPLOAD_RECOVERIES:GroupUploadRecovery[]=[];

export default function GroupDMChat({ groupId }: { groupId: string }) {
  const { t } = useTranslation("common");
  const isTouch = useIsTouch();
  const confirm = useConfirm();
  const reportFileRejections = useAttachmentRejectionToast();
  const group = useGroupDMStore((state) => state.groups.find((item) => item.id === groupId));
  const messages = useGroupDMStore((state) => state.messages[groupId] ?? EMPTY_GROUP_MESSAGES);
  const hasMoreAfter=useGroupDMStore(state=>Boolean(state.hasMoreAfterByGroup[groupId]));
  const scrollTarget=useGroupDMStore(state=>state.scrollTarget?.groupId===groupId?state.scrollTarget:null);
  const error = useGroupDMStore((state) => state.error);
  const recoveries=useGroupDMStore(state=>state.uploadRecoveries?.[groupId]??EMPTY_UPLOAD_RECOVERIES);
  const pendingSend=useGroupDMStore(state=>state.pendingSends?.[groupId]);
  const restoreStatus=useGroupDMStore(state=>state.restoreStatus);
  const restoreBlocked=useGroupDMStore(state=>state.restoreBlocked?.includes(groupId));
  const retryingUploads=recoveries.some(item=>item.retrying);
  const currentUserId = useAuthStore((state) => state.user?.id);
  const historyAuthGeneration = useAuthStore(() => getAuthGeneration());
  const cryptoReady = useE2EEStore((state) => state.initStatus === "ready");
  const localDeviceId = useE2EEStore((state) => state.localDeviceId);
  const groupsReady = useGroupDMStore((state) => state.groupsReady);
  const historyGroupEpoch = group?.key_epoch;
  const friends = useFriendStore((state) => state.friends);
  const draftKey=composerKey(currentUserId,"group",groupId);
  const composer=useComposerDraftStore(state=>state.drafts[draftKey]??EMPTY_DRAFT);
  const draft=composer.content,files=composer.files,replyToId=composer.groupReplyToId,editingId=composer.groupEditingId??null,sending=Boolean(composer.sending);
  useEffect(()=>{if(pendingSend?.restored&&!sending)useGroupDMStore.getState().prefillPendingDraft(groupId)},[groupId,pendingSend?.id,pendingSend?.restored,sending]);
  const setDraft=(content:string)=>useComposerDraftStore.getState().patch(draftKey,{content});
  const setFiles=(files:File[])=>useComposerDraftStore.getState().patch(draftKey,{files});
  const setReplyToId=(groupReplyToId:string|undefined)=>useComposerDraftStore.getState().patch(draftKey,{groupReplyToId});
  // A new jump target starts with an unfiltered timeline. Derive this from
  // the request identity instead of clearing React state in a scroll effect.
  const [searchState, setSearchState] = useState<{ value: string; request: number | null }>({ value: "", request: null });
  const searchRequest = scrollTarget?.request ?? null;
  const search = searchState.request === searchRequest ? searchState.value : "";
  const setSearch = (value: string) => setSearchState({ value, request: searchRequest });
  const [showMembers, setShowMembers] = useState(false);
  const [participantBusyContext, setParticipantBusyContext] = useState<string | null>(null);
  const [participantFailure, setParticipantFailure] = useState<{ context: string; action: "add" | "remove" | "leave"; userId?: string } | null>(null);
  const [participantErrorContext, setParticipantErrorContext] = useState<string | null>(null);
  const [selectedMemberToAdd, setSelectedMemberToAdd] = useState("");
  const participantContext = JSON.stringify([currentUserId, groupId]);
  const participantContextRef = useRef(participantContext);
  const participantMounted = useRef(true);
  useEffect(() => {
    participantContextRef.current = participantContext;
    participantMounted.current = true;
    return () => {
      if (participantContextRef.current === participantContext) participantMounted.current = false;
    };
  }, [participantContext]);
  const participantBusy = participantBusyContext === participantContext;
  const participantError = participantErrorContext === participantContext;
  const searchInput = useRef<HTMLInputElement>(null);
  const messagesScrollRef = useRef<HTMLElement>(null);
  const composerInput=useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const canAttach = !editingId && !sending && restoreStatus === "ready" && !restoreBlocked && !pendingSend && !retryingUploads;
  const expressionNavigationRevision = useUIStore((state) => state.navigationRevision);
  const expressionScope = JSON.stringify([currentUserId, getAuthGeneration(), groupId, group?.key_epoch, expressionNavigationRevision]);
  const [pinsScope, setPinsScope] = useState<string | null>(null);
  const [mutePendingScope,setMutePendingScope]=useState<string|null>(null);
  const showPins = pinsScope === expressionScope;
  const togglePins = () => {
    if (!showPins) setShowMembers(false);
    setPinsScope((previous) => previous === expressionScope ? null : expressionScope);
  };
  const toggleMembers = () => {
    if (!showMembers) setPinsScope(null);
    setShowMembers((previous) => !previous);
  };
  const [expressionPicker, setExpressionPicker] = useState<{ kind: "emoji" | "gif" | "sticker"; scope: string } | null>(null);
  const expressionMounted = useRef(false);
  useEffect(() => { expressionMounted.current = true; return () => { expressionMounted.current = false; }; }, []);
  const expressionCurrent = () => {
    const destination = useUIStore.getState().destination;
    const liveGroup = useGroupDMStore.getState().groups.find((item) => item.id === groupId);
    return expressionMounted.current && !!currentUserId && useAuthStore.getState().user?.id === currentUserId
      && expressionScope === JSON.stringify([currentUserId, getAuthGeneration(), groupId, liveGroup?.key_epoch, useUIStore.getState().navigationRevision])
      && destination.type === "group-dm" && destination.channelId === groupId;
  };
  const expressionAvailable = () => {
    const state = useGroupDMStore.getState();
    const currentDraft = useComposerDraftStore.getState().drafts[draftKey] ?? EMPTY_DRAFT;
    return expressionCurrent() && !currentDraft.groupEditingId && !currentDraft.sending
      && state.restoreStatus === "ready" && !state.restoreBlocked.includes(groupId) && !state.pendingSends[groupId]
      && !(state.uploadRecoveries[groupId] ?? []).some((item) => item.retrying);
  };
  const toggleMute=async()=>{
    if(!expressionCurrent()||mutePendingScope===expressionScope)return;
    setMutePendingScope(expressionScope);
    const ok=await useGroupDMStore.getState().setMuted(groupId,!group?.is_muted);
    if(!ok&&expressionCurrent())useToastStore.getState().addToast("error",t("somethingWentWrong"));
    setMutePendingScope(current=>current===expressionScope?null:current);
  };
  const openExpressionPicker = (kind: "emoji" | "gif" | "sticker") => {
    if (!canAttach || !expressionAvailable()) return false;
    setExpressionPicker((previous) => previous?.scope === expressionScope && previous.kind === kind ? null : { kind, scope: expressionScope });
    return true;
  };
  const activeExpressionPicker = canAttach && expressionPicker?.scope === expressionScope ? expressionPicker.kind : null;
  if (expressionPicker && (!canAttach || expressionPicker.scope !== expressionScope)) setExpressionPicker(null);
  const selectEmoji = (emoji: string) => {
    if (!expressionAvailable() || !canAttach) return;
    const store = useComposerDraftStore.getState();
    const current = store.drafts[draftKey] ?? EMPTY_DRAFT;
    const start = composerInput.current?.selectionStart ?? current.content.length;
    const end = composerInput.current?.selectionEnd ?? start;
    const content = current.content.slice(0, start) + emoji + current.content.slice(end);
    if (content.length > 4000 || current.sending) return;
    store.patch(draftKey, { content });
    setExpressionPicker(null);
    if (!isTouch) composerInput.current?.focus();
    composerInput.current?.setSelectionRange(start + emoji.length, start + emoji.length);
  };
  const sendExpression = async (content: string) => {
    if (!expressionAvailable() || !canAttach) return;
    setExpressionPicker(null);
    const store = useComposerDraftStore.getState();
    const ticket = store.beginSend(draftKey);
    if (!ticket) return;
    try {
      const sent = await useGroupDMStore.getState().send(groupId, content, undefined, undefined,
        { ownerId: currentUserId!, authGeneration: getAuthGeneration(), isCurrent: expressionCurrent });
      if (!sent && expressionCurrent()) useToastStore.getState().addToast("error", t("error"));
    } catch {
      if (expressionCurrent()) useToastStore.getState().addToast("error", t("error"));
    } finally {
      store.finishSend(draftKey, ticket, false);
      if (expressionCurrent() && !isTouch) composerInput.current?.focus();
    }
  };
  useConversationPageShortcut({ kind: "group", id: groupId }, messagesScrollRef);
  const insertTypedCharacter = useCallback((key: string) => {
    const textarea = composerInput.current;
    if (!group || !textarea || textarea.disabled || sending) return false;
    const draftStore = useComposerDraftStore.getState();
    const currentDraft = draftStore.drafts[draftKey] ?? EMPTY_DRAFT;
    if (currentDraft.sending) return false;
    const start = textarea.selectionStart ?? currentDraft.content.length;
    const end = textarea.selectionEnd ?? start;
    const nextContent = currentDraft.content.slice(0, start) + key + currentDraft.content.slice(end);
    if (nextContent.length > 4000) return false;

    const ownerId = currentUserId;
    const authGenerationAtInsert = getAuthGeneration();
    const draftGeneration = draftStore.generation;
    draftStore.patch(draftKey, { content: nextContent });
    const insertedRevision = useComposerDraftStore.getState().drafts[draftKey]?.revision;
    const cursor = start + key.length;
    window.requestAnimationFrame(() => {
      const latestDraft = useComposerDraftStore.getState().drafts[draftKey];
      if (!ownerId || useAuthStore.getState().user?.id !== ownerId || getAuthGeneration() !== authGenerationAtInsert ||
        useComposerDraftStore.getState().generation !== draftGeneration || latestDraft?.revision !== insertedRevision ||
        latestDraft.content !== nextContent || composerInput.current !== textarea || !textarea.isConnected) return;
      textarea.setSelectionRange(cursor, cursor);
    });
    return true;
  }, [currentUserId, draftKey, group, sending]);
  useFocusComposerOnTyping({ kind: "group", id: groupId }, composerInput, insertTypedCharacter, Boolean(group) && !sending && !isTouch);
  const manualUnread = useRef(false);
  useConversationCommand({kind:"group",id:groupId}, (command) => {
    if (!group) return false;
    if (command === "pins") { togglePins(); return true; }
    if (command === "members") { toggleMembers(); return true; }
    if (command === "search" && searchInput.current) { searchInput.current.focus(); return true; }
    if (command === "upload" && canAttach && fileInput.current) { fileInput.current.click(); return true; }
    if (command === "emoji" || command === "gif" || command === "sticker") return openExpressionPicker(command);
    return false;
  });
  const call = useGroupCallStore(state=>state.session);
  const ownCall = call?.groupId===groupId && call.ownerId===currentUserId ? call : null;
  const authGeneration = getAuthGeneration();
  const [reporting, setReporting] = useState<GroupDMMessage | null>(null);
  const [forwarding,setForwarding]=useState<GroupDMMessage|null>(null);
  const currentForward=messages.find(message=>message===forwarding&&message.group_id===groupId&&message.content!==null);
  const forwardSource=useMemo<ForwardableMessage|undefined>(()=>{
    if(!currentForward)return undefined;
    const author=currentForward.user??group?.members.find(member=>member.id===currentForward.user_id);
    return {id:currentForward.id,user_id:currentForward.user_id,content:currentForward.content,attachments:currentForward.attachments,encryption_version:currentForward.encryption_version,e2ee_file_keys:currentForward.e2ee_file_keys,author};
  },[currentForward,group?.members]);
  const availableFriends = useMemo(() => friends.filter((friend) => !group?.members.some((member) => member.id === friend.user_id)), [friends, group]);
  const visibleMessages = useMemo(() => { const q=search.trim().toLocaleLowerCase(); return q ? messages.filter((m)=>(m.content??"").toLocaleLowerCase().includes(q)) : messages; }, [messages,search]);
  const messageIndex = useMemo(() => new Map(messages.map(message => [message.id, message])), [messages]);
  const memberIndex = useMemo(() => new Map(group?.members.map(member => [member.id, member]) ?? []), [group?.members]);
  const [focusedMessage, setFocusedMessage] = useState<string | null>(null);
  const focusedElement = useRef<HTMLElement | null>(null);
  const virtualized = visibleMessages.length > 80;
  const scrollAnchor = useRef<{ id: string; offset: number } | null>(null);
  const previousFirst = useRef<string | undefined>(undefined);
  const getMessageKey = useCallback((index: number) => visibleMessages[index].id, [visibleMessages]);
  const virtualizer = useVirtualizer({
    count: visibleMessages.length,
    enabled: virtualized,
    getScrollElement: () => messagesScrollRef.current,
    estimateSize: () => 140,
    getItemKey: getMessageKey,
    overscan: 12,
    initialRect: { width: 800, height: 600 },
    onChange: (instance, scrolling) => {
      if (!scrolling) return;
      const offset = instance.scrollOffset ?? 0;
      const first = instance.getVirtualItems().find(item => item.end > offset);
      if (first) scrollAnchor.current = { id: String(first.key), offset: offset - first.start };
    },
    rangeExtractor: range => {
      const indexes = defaultRangeExtractor(range);
      const focused = visibleMessages.findIndex(message => message.id === focusedMessage);
      if (focused >= 0 && !indexes.includes(focused)) indexes.push(focused);
      return indexes.sort((a, b) => a - b);
    },
  });
  const virtualRows = virtualizer.getVirtualItems();
  useLayoutEffect(() => {
    // Chromium drops DOM focus when React reorders a retained keyed row.
    if (focusedMessage && focusedElement.current?.isConnected && document.activeElement === document.body) {
      focusedElement.current.focus({ preventScroll: true });
    }
  }, [virtualRows, focusedMessage]);
  useLayoutEffect(() => {
    const before = previousFirst.current;
    previousFirst.current = visibleMessages[0]?.id;
    const anchor = scrollAnchor.current;
    if (!virtualized || !before || !anchor || visibleMessages.findIndex(message => message.id === before) <= 0) return;
    const index = visibleMessages.findIndex(message => message.id === anchor.id);
    if (index >= 0) {
      const target = virtualizer.getOffsetForIndex(index, "start");
      if (target) virtualizer.scrollToOffset(target[0] + anchor.offset);
    }
  }, [visibleMessages, virtualized, virtualizer]);
  useEffect(()=>{if(editingId)composerInput.current?.focus()},[editingId,draftKey]);

  useEffect(() => {
    if (!currentUserId || historyGroupEpoch === undefined || !groupsReady || !cryptoReady || !localDeviceId) return;
    let active=true;manualUnread.current=false;
    const owner=useAuthStore.getState().user;
    void useGroupDMStore.getState().fetchMessages(groupId).then(fetched=>{
      if(!fetched||!active || manualUnread.current || useAuthStore.getState().user!==owner)return;
      const latest=useGroupDMStore.getState().messages[groupId]?.at(-1);
      void useGroupDMStore.getState().markRead(groupId,latest?.id);
    });
    return()=>{active=false};
  }, [groupId, currentUserId, historyAuthGeneration, historyGroupEpoch, groupsReady, cryptoReady, localDeviceId]);
  useEffect(()=>{
    if(!scrollTarget)return;
    const clear=()=>useGroupDMStore.getState().clearScrollTarget(scrollTarget.request);
    const destination=useUIStore.getState().destination;
    if(useAuthStore.getState().user?.id!==scrollTarget.accountId||getAuthGeneration()!==scrollTarget.authGeneration||
      destination.type!=="group-dm"||destination.channelId!==groupId||!useGroupDMStore.getState().groups.some(item=>item.id===groupId)){
      clear();return;
    }
    if(!visibleMessages.some(message=>message.id===scrollTarget.messageId)){
      if(messages.some(message=>message.id===scrollTarget.messageId)&&search){clear();return}
      if(!messages.some(message=>message.id===scrollTarget.messageId))clear();
      return;
    }
    const target=Array.from(messagesScrollRef.current?.querySelectorAll<HTMLElement>("[data-group-message-id]")??[])
      .find(element=>element.dataset.groupMessageId===scrollTarget.messageId);
    if(!target){
      if(virtualized)virtualizer.scrollToIndex(visibleMessages.findIndex(message=>message.id===scrollTarget.messageId),{align:"center"});
      return;
    }
    if(typeof target.scrollIntoView==="function")target.scrollIntoView({block:"center"});
    else if(messagesScrollRef.current)messagesScrollRef.current.scrollTop=Math.max(0,messagesScrollRef.current.scrollTop + target.getBoundingClientRect().top - messagesScrollRef.current.getBoundingClientRect().top - messagesScrollRef.current.clientHeight/2);
    target.classList.add("msg-highlight");
    window.setTimeout(()=>target.classList.remove("msg-highlight"),2000);
    clear();
  },[scrollTarget,visibleMessages,messages,search,groupId,virtualized,virtualizer,virtualRows]);
  useVoiceShortcutAction("group-call-start", () => {
    const destination = useUIStore.getState().destination;
    const activeUserId = useAuthStore.getState().user?.id;
    if (!currentUserId || activeUserId !== currentUserId || getAuthGeneration() !== authGeneration ||
        destination.type !== "group-dm" || destination.channelId !== groupId || !group || call) return false;
    return joinCall();
  });
  if (!group) return <div className="shell-empty" role="status"><h2>{t("groupUnavailable")}</h2></div>;

  async function send() {
    if(useGroupDMStore.getState().pendingSends?.[groupId])return;
    if(useGroupDMStore.getState().uploadRecoveries[groupId]?.some(item=>item.retrying))return;
    const store=useComposerDraftStore.getState(),snapshot=store.drafts[draftKey]??EMPTY_DRAFT;
    if (!snapshot.content.trim()&&!snapshot.files.length) return;
    const ticket=store.beginSend(draftKey);if(!ticket)return;
    let ok=false;
    try{ok=snapshot.groupEditingId ? await useGroupDMStore.getState().edit(groupId,snapshot.groupEditingId,snapshot.content) : await useGroupDMStore.getState().send(groupId,snapshot.content,snapshot.groupReplyToId,snapshot.files)}
    finally{useComposerDraftStore.getState().finishSend(draftKey,ticket,ok,snapshot.groupEditingId?"group-edit":"message")}
  }

  async function leave() {
    await runParticipantAction("leave");
  }

  async function runParticipantAction(action: "add" | "remove" | "leave", userId?: string) {
    const requestContext = participantContext;
    const requestGroupId = groupId;
    const requestAccountId = currentUserId;
    if (!requestAccountId || participantBusyContext === requestContext || !participantMounted.current) return false;
    const currentGroup = useGroupDMStore.getState().groups.find((item) => item.id === requestGroupId);
    if (!currentGroup || useAuthStore.getState().user?.id !== requestAccountId) return false;
    if ((action === "add" || action === "remove") && currentGroup.owner_id !== requestAccountId) return false;
    setParticipantBusyContext(requestContext);
    setParticipantErrorContext(null);
    setParticipantFailure(null);
    let succeeded: boolean;
    try {
      const store = useGroupDMStore.getState();
      succeeded = action === "leave" ? await store.leave(requestGroupId)
        : action === "add" ? Boolean(userId && await store.addMember(requestGroupId, userId))
          : Boolean(userId && await store.removeMember(requestGroupId, userId));
    } catch {
      const stillCurrent = participantMounted.current && participantContextRef.current === requestContext && useAuthStore.getState().user?.id === requestAccountId;
      if (!stillCurrent) return false;
      setParticipantBusyContext(null);
      setParticipantErrorContext(requestContext);
      setParticipantFailure({ context: requestContext, action, userId });
      return false;
    }
    const stillCurrent = participantMounted.current && participantContextRef.current === requestContext && useAuthStore.getState().user?.id === requestAccountId;
    if (!stillCurrent) return false;
    setParticipantBusyContext(null);
    if (!succeeded) {
      setParticipantErrorContext(requestContext);
      setParticipantFailure({ context: requestContext, action, userId });
      return false;
    }
    setParticipantErrorContext(null);
    setParticipantFailure(null);
    if (action === "add") setSelectedMemberToAdd("");
    if (action === "leave") useUIStore.getState().navigate({ type: "friends", channelId: "friends", label: t("friends") });
    return true;
  }

  async function deleteGroupMessage(messageId: string) {
    if (!await confirm({ message: t("chat:deleteMessageConfirm"), confirmLabel: t("delete"), danger: true })) return;
    if (!currentUserId || useAuthStore.getState().user?.id !== currentUserId) return;
    await useGroupDMStore.getState().removeMessage(groupId, messageId);
  }

  function joinCall(): boolean {
    const destination=useUIStore.getState().destination;
    if(!currentUserId||useAuthStore.getState().user?.id!==currentUserId||getAuthGeneration()!==authGeneration
      ||destination.type!=="group-dm"||destination.channelId!==groupId)return false;
    return useGroupCallStore.getState().join(groupId);
  }

  return <div className="group-dm-chat">
    <header className="channel-bar">
      <span aria-hidden="true">◉</span><strong>{group.name}</strong>
      <span className="group-dm-member-count">{t("memberCount", { count: group.members.length })}</span>
      <button disabled={!!call&&!ownCall} onClick={() => ownCall ? useGroupCallStore.getState().leave(ownCall.nonce) : void joinCall()}>{t(ownCall ? "leaveCall" : "startCall")}</button>
      <button onClick={toggleMembers} aria-expanded={showMembers}>{t("members")}</button>
      <button type="button" aria-expanded={showPins} onClick={togglePins}>{t("chat:pinnedMessages")}</button>
      <button type="button" aria-pressed={!!group.is_muted} disabled={mutePendingScope===expressionScope} onClick={()=>void toggleMute()}>{t(group.is_muted?"dm:unmuteDM":"dm:muteDM")}</button>
      <input ref={searchInput} type="search" value={search} onChange={(e)=>setSearch(e.target.value)} onKeyDown={(e)=>{if(e.key==="Enter"){e.preventDefault();void useGroupDMStore.getState().searchMessages(groupId,search)}}} placeholder={t("search")} aria-label={t("search")} />
    </header>
    <div className="group-dm-body">
      <main ref={messagesScrollRef} className="group-dm-messages" aria-live="polite">
        <div style={virtualized ? {height:virtualizer.getTotalSize(),position:"relative"} : undefined}>
        {(virtualized ? virtualRows.map(row=>({message:visibleMessages[row.index],row})) : visibleMessages.map(message=>({message,row:undefined}))).map(({message,row}) => {
          const author = message.user ?? memberIndex.get(message.user_id);
          const referenced = message.reply_to_id ? messageIndex.get(message.reply_to_id) : undefined;
          const edit = () => { useComposerDraftStore.getState().beginGroupEdit(draftKey,message.id,message.content ?? ""); };
          const remove = () => { void deleteGroupMessage(message.id); };
          const copy = () => { if (message.content) void copyToClipboard(message.content).catch(() => useToastStore.getState().addToast("error", t("shortcutCopyFailed"))); };
          const speak = () => { if (!speakMessage(author?.display_name || author?.username || "",message.content)) useToastStore.getState().addToast("error",t("shortcutSpeechUnavailable")); };
          const unread = () => { manualUnread.current=true; void useGroupDMStore.getState().markUnread(groupId,message.id).then(ok=>{if(!ok && useAuthStore.getState().user?.id===currentUserId)useToastStore.getState().addToast("error",t("chat:markUnreadFailed"));}); };
          const keyboardActions: MessageAction[] = [
            {id:"pin",label:t("chat:pinMessage"),run:()=>{
              if (!expressionCurrent()) return;
              void pinCurrentGroupDMMessage(groupId, message.id, { ownerId: currentUserId!, authGeneration: getAuthGeneration(), isCurrent: expressionCurrent }).then((ok) => {
                if (!expressionCurrent()) return;
                if (ok) setPinsScope(expressionScope);
                else useToastStore.getState().addToast("error", t("error"));
              });
            }},
            {id:"reply",label:t("reply"),disabled:Boolean(editingId),run:()=>setReplyToId(message.id)},
            {id:"reaction",label:"👍",run:()=>{void useGroupDMStore.getState().toggleReaction(groupId,message.id,"👍");}},
            {id:"forward",label:t("chat:forwardMessage"),disabled:message.content===null,run:()=>setForwarding(message)},
            {id:"mark-unread",label:t("chat:markUnread"),run:unread},
            ...(message.content?.trim() ? [{id:"copy" as const,label:t("chat:copyMessage"),run:copy},{id:"speak" as const,label:t("shortcutMessageSpeak"),run:speak}] : []),
            ...(message.user_id === currentUserId ? [...(message.content !== null ? [{id:"edit" as const,label:t("edit"),disabled:sending||Boolean(editingId&&editingId!==message.id),run:edit}] : []),{id:"delete" as const,label:t("delete"),run:remove}] : []),
          ];
          return <article key={message.id} ref={row ? virtualizer.measureElement : undefined} data-index={row?.index}
            style={row ? {position:"absolute",top:0,left:0,width:"100%",transform:`translateY(${row.start}px)`,marginBottom:0,paddingBottom:16} : undefined}
            onFocusCapture={event=>{focusedElement.current=event.target as HTMLElement;setFocusedMessage(message.id)}}
            onBlurCapture={event=>{if(event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)){focusedElement.current=null;setFocusedMessage(null)}}}
            aria-posinset={row ? row.index+1 : undefined} aria-setsize={virtualized ? visibleMessages.length : undefined}
            className="group-dm-message" data-group-message-id={message.id}>
            <Avatar name={author?.display_name || author?.username || "?"} avatarUrl={author?.avatar_url ?? undefined} size={36} />
            <div><strong>{author?.display_name || author?.username || t("unknownUser")}</strong><time>{formatDateTime(message.created_at)}</time>
              <GroupSpamGate message={message} keyboardActions={keyboardActions}>
              {message.reply_to_id && <small>↪ {referenced ? <SpamPreview kind="group" message={{ ...referenced, content: referenced.content ?? null }} /> : t("encryptedMessageUnavailable")}</small>}
              <GroupDMMessageBody message={message} members={group.members} />
              {message.attachments?.map((attachment, index) => {
                const meta = groupAttachmentKey(message.e2ee_file_keys,attachment,index);
                if (!meta) return null;
                const content = <EncryptedAttachment attachment={attachment} fileMeta={meta} authorName={author?.display_name || author?.username} createdAt={message.created_at} messageId={message.id} />;
                return /^(image|video)\//.test(meta.mimeType)
                  ? <UnclassifiedMediaGate key={attachment.id} privateConversation sourceKind="group" sourceChannelId={groupId} messageId={message.id} revision={message.edited_at ?? "original"} mediaInputs={[{url:attachment.file_url,mimeType:meta.mimeType,fileMeta:meta}]} authorId={message.user_id} identity={`${groupId}:${message.id}:${attachment.id}`}>{content}</UnclassifiedMediaGate>
                  : <span key={attachment.id}>{content}</span>;
              })}
              <div className="group-dm-message-actions">{keyboardActions.map((action)=><button key={action.id} type="button" disabled={action.disabled} title={action.id==="edit"&&action.disabled?t("groupFinishCurrentEdit"):undefined} onClick={action.run}>{action.label}</button>)}</div>
              {message.reactions?.map((reaction)=><button key={reaction.emoji} onClick={()=>void useGroupDMStore.getState().toggleReaction(groupId,message.id,reaction.emoji)}>{reaction.emoji} {reaction.count}</button>)}
              </GroupSpamGate>
              {message.user_id !== currentUserId && <button onClick={() => setReporting(message)}>{t("chat:reportMessage")}</button>}
            </div>
          </article>;
        })}
        </div>
      </main>
      {hasMoreAfter&&<JumpToPresentPill onClick={()=>useGroupDMStore.getState().jumpToPresent(groupId)}/>}
      {showPins && <GroupDMPinsPanel key={expressionScope} groupId={groupId} onClose={() => setPinsScope(null)} />}
      {showMembers && <aside className="group-dm-members" aria-busy={participantBusy}>
        <h3>{t("members")}</h3>
        {group.members.map((member) => <div key={member.id} className="group-dm-member"><Avatar name={member.display_name || member.username} avatarUrl={member.avatar_url ?? undefined} size={28} /><span>{member.display_name || member.username}</span>
          {group.owner_id === currentUserId && member.id !== currentUserId && <button disabled={participantBusy} onClick={() => void runParticipantAction("remove", member.id)}>{t("remove")}</button>}</div>)}
        {group.owner_id === currentUserId && group.members.length < 10 && availableFriends.length > 0 && <label>{t("addMember")}<select value={selectedMemberToAdd} disabled={participantBusy} onChange={(event) => { const id = event.target.value; setSelectedMemberToAdd(id); if (id) void runParticipantAction("add", id); }}><option value="">{t("chooseFriend")}</option>{availableFriends.map((friend) => <option key={friend.user_id} value={friend.user_id}>{friend.display_name || friend.username}</option>)}</select></label>}
        <button className="btn-danger" disabled={participantBusy} onClick={() => void leave()}>{t("leaveGroup")}</button>
        {participantError && <div role="alert"><p>{t("error")}</p>{participantFailure?.context === participantContext && <button type="button" disabled={participantBusy} onClick={() => void runParticipantAction(participantFailure.action, participantFailure.userId)}>{t("errorBoundary.retry")}</button>}</div>}
      </aside>}
    </div>
    {(error||restoreStatus!=="ready"||restoreBlocked)&&<div className="group-dm-error" role="alert"><p>{t(error??"groupSendRestoreBlocked",{defaultValue:error??"groupSendRestoreBlocked"})}</p>{(restoreStatus!=="ready"||restoreBlocked)&&<button type="button" disabled={restoreStatus==="loading"} onClick={()=>void useGroupDMStore.getState().restorePendingSends(true)}>{t("groupSendRestoreRetry")}</button>}</div>}
    {reporting && reporting.group_id === groupId && <ReportModal key={reporting.id} userId={reporting.user_id} username={reporting.user?.display_name || reporting.user?.username || t("unknownUser")} onClose={() => setReporting(null)} messageEvidence={{ kind: "group", channelId: groupId, messageId: reporting.id, content: reporting.content ?? "", encrypted: true }} />}
    {forwardSource&&<ForwardMessageModal key={`${groupId}:${forwardSource.id}`} message={forwardSource} onClose={()=>setForwarding(null)}/>}
    {(recoveries.length>0||pendingSend)&&<section aria-label={t("groupUploadRecovery")} className="group-dm-upload-recoveries">
      {pendingSend&&<div role="status"><p>{t(pendingSend.resultConfirmed?"groupSendCommittedRecovery":pendingSend.restored?"groupSendRestored":"groupSendUncertain")}</p><p>{t(pendingSend.stored?"groupSendSavedKeepOpen":"groupSendKeepOpen")}</p><button type="button" disabled={pendingSend.busy||sending||restoreStatus!=="ready"||restoreBlocked} onClick={()=>void useGroupDMStore.getState().retryPendingSend(groupId)}>{t(pendingSend.busy?"groupSendChecking":pendingSend.lookupOnly||!pendingSend.current()?"groupSendCheckOnly":"groupSendCheckRetry")}</button>
        {pendingSend.restored&&(pendingSend.files?.length??0)>0&&<ul>{pendingSend.files?.map((file,index)=><li key={index}>{file.name}</li>)}</ul>}
        {!pendingSend.resultConfirmed&&<button type="button" disabled={pendingSend.busy||sending} onClick={async()=>{const id=pendingSend.id;if(await confirm({message:t("groupSendCancelConfirm"),confirmLabel:t("groupSendCancel")})){if(useGroupDMStore.getState().pendingSends[groupId]?.id===id)await useGroupDMStore.getState().cancelPendingSend(groupId)}}}>{t("groupSendCancel")}</button>}
      </div>}
      {recoveries.map(item=><div key={item.id} role="status">
      <p>{t(item.cancelled?"groupSendCancelledFiles":item.retryable?"groupUploadsPartial":"groupUploadsReview",{count:item.files.length})}</p>
      <ul>{item.files.map((file,index)=><li key={index}>{file.name}</li>)}</ul>
      {item.retryable&&<button type="button" disabled={item.retrying||sending||Boolean(pendingSend)} onClick={()=>void useGroupDMStore.getState().retryUploadRecovery(groupId,item.id)}>{t(item.retrying?"groupRetryingFiles":"groupRetryFailedFiles")}</button>}
      <button type="button" disabled={item.retrying||sending||Boolean(pendingSend)} onClick={()=>{if(useGroupDMStore.getState().restoreUploadRecovery(groupId,item.id)&&!item.cancelled)useToastStore.getState().addToast("warning",t("groupReviewUploadSelection"))}}>{t("groupReviewFiles")}</button>
      <button type="button" disabled={item.retrying||Boolean(pendingSend)} onClick={()=>useGroupDMStore.getState().dismissUploadRecovery(groupId,item.id)}>{t("groupDismissFailedFiles")}</button>
    </div>)}</section>}
    <form className="group-dm-composer" onSubmit={(event) => { event.preventDefault(); void send(); }}>
      <div className="group-dm-expression-tools" style={{ position: "relative" }}>
        <button type="button" disabled={!canAttach} aria-label={t("chat:emoji")} onClick={() => openExpressionPicker("emoji")}>☺</button>
        <button type="button" disabled={!canAttach} aria-label={t("chat:gif")} onClick={() => openExpressionPicker("gif")}>GIF</button>
        <button type="button" disabled={!canAttach} aria-label={t("expressions:stickerButton")} onClick={() => openExpressionPicker("sticker")}>▧</button>
        {activeExpressionPicker === "emoji" && <EmojiPicker customEmojis onSelect={selectEmoji} onClose={() => setExpressionPicker(null)} />}
        {activeExpressionPicker === "gif" && <GifPicker onSelect={(url) => { void sendExpression(url); }} onClose={() => setExpressionPicker(null)} />}
        {activeExpressionPicker === "sticker" && <StickerPicker onSelect={(token) => { void sendExpression(token); }} onClose={() => setExpressionPicker(null)} />}
      </div>
      {(replyToId||editingId)&&<div className="group-dm-composer-context">{editingId?t("edit"):t("reply")}<button type="button" aria-label={t(editingId?"groupCancelEdit":"groupCancelReply")} disabled={Boolean(editingId&&sending)} onClick={()=>{if(editingId)useComposerDraftStore.getState().cancelGroupEdit(draftKey);else setReplyToId(undefined);composerInput.current?.focus()}}>×</button></div>}
      <textarea ref={composerInput} value={draft} onChange={(event) => setDraft(event.target.value)} maxLength={4000} placeholder={t("messageGroup", { name: group.name })} onKeyDown={(event) => {
        if(event.nativeEvent.isComposing)return;
        if(event.key==="Escape"&&editingId&&!sending){event.preventDefault();event.stopPropagation();useComposerDraftStore.getState().cancelGroupEdit(draftKey);return}
        if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); }
      }} />
      {!editingId&&<input ref={fileInput} type="file" multiple disabled={!canAttach} aria-label={t("groupAttachFiles")} onChange={(e)=>{
        const selected = Array.from(e.target.files ?? []);
        e.target.value = "";
        if (!canAttach) return;
        const { valid, rejected } = validateFiles(selected);
        reportFileRejections(rejected);
        const currentFiles = useComposerDraftStore.getState().drafts[draftKey]?.files ?? [];
        const remaining = Math.max(0, MAX_FILES - currentFiles.length);
        if (valid.length > remaining) useToastStore.getState().addToast("warning", t("chat:tooManyFiles", { max: MAX_FILES }));
        setFiles([...currentFiles, ...valid.slice(0, remaining)]);
      }}/>} {files.length>0&&<ul className="group-dm-composer-files">{files.map((file,index)=><li key={index}><span>{file.name}</span><button type="button" aria-label={t("groupRemoveFile",{filename:file.name})} onClick={()=>setFiles(files.filter((_,position)=>position!==index))}>×</button></li>)}</ul>}
      <button className="btn-primary" disabled={sending || restoreStatus!=="ready" || restoreBlocked || Boolean(pendingSend) || retryingUploads || (!draft.trim()&&!files.length)}>{t("send")}</button>
    </form>
  </div>;
}
