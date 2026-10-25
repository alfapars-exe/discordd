import { useTranslation } from "react-i18next";
import { getAuthGeneration } from "../../api/client";
import { useAuthStore } from "../../stores/authStore";
import { useBlockStore } from "../../stores/blockStore";
import { useGameActivityStore, gameActivityKey } from "../../stores/gameActivityStore";
import { usePresenceStore } from "../../stores/presenceStore";

/** Never reuse a server-scoped grant outside its server (or as a global profile grant). */
export default function GameActivityLabel({ userId, serverId, visible = true, className = "member-activity" }: { userId: string; serverId?: string; visible?: boolean; className?: string }) {
  const { t } = useTranslation("common");
  const owner = useAuthStore((s) => s.user?.id);
  const blocked = useBlockStore((s) => s.blockedUserIds.includes(userId));
  const offline = usePresenceStore((s) => s.statusByUserId[userId] === "offline");
  const game = useGameActivityStore((s) => s.ownerId === owner && s.authGeneration === getAuthGeneration()
    ? s.entries[gameActivityKey(userId, serverId)]?.game : null);
  if (!visible || offline || blocked || !game) return null;
  return <span className={className} title={t("gameActivitySelfReported")}>{t("gameActivityPlaying", { name: game.name })}</span>;
}
