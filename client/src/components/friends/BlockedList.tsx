/** BlockedList — "Blocked" tab of the friends page: list + unblock. */

import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useBlockStore } from "../../stores/blockStore";
import * as blockApi from "../../api/block";
import Avatar from "../shared/Avatar";
import type { FriendshipWithUser } from "../../types";

function BlockedList() {
  const { t } = useTranslation("common");
  const unblockUser = useBlockStore((s) => s.unblockUser);
  // blockStore only holds ids; the full rows (name, avatar) come from the API.
  // Re-fetch whenever the id list changes so a block/unblock arriving over WS
  // (or from another view) shows up here without a remount.
  const blockedIds = useBlockStore((s) => s.blockedUserIds);
  const [blockedUsers, setBlockedUsers] = useState<FriendshipWithUser[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => setIsLoading(true));
    blockApi.listBlocked().then((res) => {
      if (cancelled) return;
      if (res.success && res.data) {
        setBlockedUsers(res.data);
      }
      setIsLoading(false);
    }).catch(() => {
      if (!cancelled) setIsLoading(false);
    });
    return () => { cancelled = true; };
  }, [blockedIds]);

  async function handleUnblock(userId: string) {
    const ok = await unblockUser(userId);
    if (ok) {
      setBlockedUsers((prev) => prev.filter((u) => u.user_id !== userId));
    }
  }

  if (isLoading) {
    return <div className="fv-empty">{t("loading")}</div>;
  }

  if (blockedUsers.length === 0) {
    return <div className="fv-empty">{t("noBlockedUsers")}</div>;
  }

  return (
    <div className="blocked-users-list">
      {blockedUsers.map((user) => {
        const name = user.display_name || user.username;
        return (
          <div key={user.user_id} className="blocked-user-item">
            <Avatar
              name={name}
              avatarUrl={user.avatar_url}
              size={36}
              isCircle
            />
            <div className="blocked-user-info">
              <span className="blocked-user-name">{name}</span>
              <span className="blocked-user-username">@{user.username}</span>
            </div>
            <button
              className="blocked-user-unblock"
              onClick={() => handleUnblock(user.user_id)}
            >
              {t("unblock")}
            </button>
          </div>
        );
      })}
    </div>
  );
}

export default BlockedList;
