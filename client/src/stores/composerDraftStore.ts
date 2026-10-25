import { create } from "zustand";
import type { ChatMessage } from "../hooks/useChatContext";
import type { MentionSelection } from "../components/chat/MentionAutocomplete";
import type { CustomEmojiRef } from "../utils/expressionTokens";

/** Memory only: message plaintext and File objects must never enter localStorage. */
export type ComposerDraft = {
  content: string;
  files: File[];
  replyingTo: ChatMessage | null;
  mentions: MentionSelection[];
  emojis: CustomEmojiRef[];
  revision: number;
  sending: SendTicket | null;
  groupReplyToId?:string;
  groupEditingId?:string|null;
  groupEditBackup?:GroupDraftBackup;
};
type GroupDraftBackup=Pick<ComposerDraft,"content"|"files"|"replyingTo"|"mentions"|"emojis"|"groupReplyToId">;
type DraftFields = Pick<ComposerDraft, "content" | "files" | "replyingTo" | "mentions" | "emojis" | "groupReplyToId" | "groupEditingId">;
export type SendTicket = { revision: number; generation: number; id: number };
export const EMPTY_DRAFT: ComposerDraft = {
  content: "", files: [], replyingTo: null, mentions: [], emojis: [], revision: 0, sending: null,
};

export function composerKey(accountId: string | undefined, mode: "channel" | "dm" | "group", channelId: string, serverId?: string) {
  return JSON.stringify([accountId ?? "", mode, mode === "channel" ? serverId ?? "" : "", channelId]);
}

/** Same scope as drafts; cleared on session reset together with sensitive state. */
export const conversationScrollPositions = new Map<string, number>();
let nextSendId = 0;

type DraftState = {
  drafts: Record<string, ComposerDraft>;
  generation: number;
  patch: (key: string, fields: Partial<DraftFields>) => void;
  beginSend: (key: string) => SendTicket | null;
  finishSend: (key: string, ticket: SendTicket, success: boolean, kind?: "message" | "command" | "group-edit") => boolean;
  beginGroupEdit:(key:string,messageId:string,content:string)=>boolean;
  cancelGroupEdit:(key:string)=>boolean;
  reset: () => void;
};

export const useComposerDraftStore = create<DraftState>((set, get) => ({
  drafts: {},
  generation: 0,
  patch: (key, fields) => set((state) => {
    const draft = state.drafts[key] ?? EMPTY_DRAFT;
    return { drafts: { ...state.drafts, [key]: { ...draft, ...fields, revision: draft.revision + 1 } } };
  }),
  beginGroupEdit:(key,messageId,content)=>{
    const state=get(),draft=state.drafts[key]??EMPTY_DRAFT;
    if(!messageId || draft.sending)return false;
    if(draft.groupEditingId)return draft.groupEditingId===messageId;
    const backup:GroupDraftBackup={content:draft.content,files:draft.files,replyingTo:draft.replyingTo,mentions:draft.mentions,emojis:draft.emojis,groupReplyToId:draft.groupReplyToId};
    set({drafts:{...state.drafts,[key]:{...draft,content,files:[],replyingTo:null,mentions:[],emojis:[],groupReplyToId:undefined,groupEditingId:messageId,groupEditBackup:backup,revision:draft.revision+1}}});
    return true;
  },
  cancelGroupEdit:key=>{
    const state=get(),draft=state.drafts[key];
    if(!draft?.groupEditingId||draft.sending)return false;
    set({drafts:{...state.drafts,[key]:{...EMPTY_DRAFT,...draft.groupEditBackup,revision:draft.revision+1}}});
    return true;
  },
  beginSend: (key) => {
    const state = get();
    const draft = state.drafts[key] ?? EMPTY_DRAFT;
    if (draft.sending) return null;
    const ticket = { revision: draft.revision, generation: state.generation, id: ++nextSendId };
    set({ drafts: { ...state.drafts, [key]: { ...draft, sending: ticket } } });
    return ticket;
  },
  finishSend: (key, ticket, success, kind = "message") => {
    const state = get();
    const draft = state.drafts[key];
    // Logging out invalidates all in-flight completions, including same-account re-login.
    if (state.generation !== ticket.generation || draft?.sending !== ticket) return false;
    const clear = success && draft.revision === ticket.revision;
    if(clear && kind==="group-edit"){
      set({drafts:{...state.drafts,[key]:{...EMPTY_DRAFT,...draft.groupEditBackup,revision:draft.revision+1}}});
      return true;
    }
    set({ drafts: { ...state.drafts, [key]: clear
      ? { ...EMPTY_DRAFT, revision: draft.revision + 1,
        // Commands consume their text, not the attachments or reply waiting
        // for a separate chat message. Unknown outcomes pass success=false.
        files: kind === "command" ? draft.files : [],
        replyingTo: kind === "command" ? draft.replyingTo : null }
      : { ...draft, sending: null } } });
    return clear;
  },
  reset: () => {
    conversationScrollPositions.clear();
    set((state) => ({ drafts: {}, generation: state.generation + 1 }));
  },
}));
