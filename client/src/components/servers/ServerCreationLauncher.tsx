import { useEffect } from "react";
import { getAuthGeneration } from "../../api/client";
import { useAuthStore } from "../../stores/authStore";

const OPEN_SERVER_CREATION_EVENT = "hichat:open-add-server";

/** App-level host so the shortcut works when the server rail is not mounted. */
export default function ServerCreationLauncher() {
  // Subscribe to the user object itself: a same-ID re-login can still advance
  // the auth generation and must invalidate any modal owned by the old session.
  const user = useAuthStore((state) => state.user);
  const userId = user?.id ?? null;
  const sessionKey = `${userId ?? ""}:${getAuthGeneration()}`;

  useEffect(() => {
    const open = () => {
      return;
    };
    window.addEventListener(OPEN_SERVER_CREATION_EVENT, open);
    return () => window.removeEventListener(OPEN_SERVER_CREATION_EVENT, open);
  }, [sessionKey, userId]);

  return null;
}
