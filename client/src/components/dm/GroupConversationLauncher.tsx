import { useEffect, useState } from "react";
import { useAuthStore } from "../../stores/authStore";
import { CONVERSATION_CREATE_GROUP_EVENT } from "../../utils/conversationCommands";
import NewConversationModal from "./NewConversationModal";
import { getAuthGeneration } from "../../api/client";

/** App-level host: the DM sidebar is unmounted while viewing a server in V2. */
export default function GroupConversationLauncher() {
  const user = useAuthStore(state => state.user);
  const userId = user?.id;
  const [owner, setOwner] = useState<string | null>(null);
  const sessionKey = `${userId ?? ""}:${getAuthGeneration()}`;
  useEffect(() => {
    const open = () => {
      if (!userId || document.querySelector("[role='dialog'], dialog[open], [role='menu']")) return;
      setOwner(sessionKey);
    };
    window.addEventListener(CONVERSATION_CREATE_GROUP_EVENT, open);
    return () => window.removeEventListener(CONVERSATION_CREATE_GROUP_EVENT, open);
  }, [userId, sessionKey]);
  return userId && owner === sessionKey ? <NewConversationModal key={owner} initialGroupMode onClose={() => setOwner(null)} /> : null;
}
