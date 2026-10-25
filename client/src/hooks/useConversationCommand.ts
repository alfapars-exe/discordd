import { useEffect, useRef } from "react";
import { CONVERSATION_COMMAND_EVENT, type ConversationCommand, type ConversationTarget, type ConversationCommandDetail } from "../utils/conversationCommands";

export function useConversationCommand(target: ConversationTarget, handle: (command: ConversationCommand) => boolean) {
  const latest = useRef(handle);
  useEffect(() => { latest.current = handle; }, [handle]);
  useEffect(() => {
    const listener = (event: Event) => {
      if (event.defaultPrevented || !(event instanceof CustomEvent)) return;
      const detail = event.detail as ConversationCommandDetail | undefined;
      if (!detail?.target || detail.target.kind !== target.kind || detail.target.id !== target.id || detail.target.serverId !== target.serverId) return;
      if (!["search","pins","members","emoji","gif","sticker","upload"].includes(detail.command)) return;
      if (latest.current(detail.command)) event.preventDefault();
    };
    window.addEventListener(CONVERSATION_COMMAND_EVENT, listener);
    return () => window.removeEventListener(CONVERSATION_COMMAND_EVENT, listener);
  }, [target.kind,target.id,target.serverId]);
}
