/**
 * NotificationItem — one row of the activity feed: actor avatar, localised
 * headline per kind, optional preview, relative time, unread dot.
 */

import { useTranslation } from "react-i18next";
import Avatar from "../shared/Avatar";
import { formatRelativePast } from "../../utils/dateFormat";
import { notificationActorName } from "../../hooks/useNotificationNavigation";
import type { AppNotification } from "../../types";
import { anniversaryYears as getAnniversaryYears } from "../../utils/anniversaryNotifications";
import { isGroupMessageNotification, isPrivateMessageNotification } from "../../utils/dmMessageNotification";

type NotificationItemProps = {
  notification: AppNotification;
  onOpen: (n: AppNotification) => void;
};

const KIND_KEY: Record<AppNotification["kind"], string> = {
  mention: "kind.mention",
  reply: "kind.reply",
  friend_request: "kind.friendRequest",
  dm_request: "kind.dmRequest",
  system: "kind.system",
};

function NotificationItem({ notification: n, onOpen }: NotificationItemProps) {
  const { t, i18n } = useTranslation("inbox");
  const { t: tCommon } = useTranslation("common");

  const name = notificationActorName(n, tCommon("directMessages"));
  const channel = typeof n.payload.channel_name === "string" ? n.payload.channel_name : "";
  const isProfileUpdate = n.kind === "system" && n.payload.action === "profile_update";
  const anniversaryYears = getAnniversaryYears(n);
  const isReaction = n.kind === "system" && n.payload.subtype === "reaction";
  const isIncomingMessage = n.kind === "system" && n.payload.action === "incoming_message";
  const headline =
    isGroupMessageNotification(n) ? t("kind.groupMessage", { name }) : isPrivateMessageNotification(n) ? t("kind.directMessage", { name })
      : isIncomingMessage ? t("kind.system", { name }) : n.kind === "system" && n.payload.action === "stream_start"
      ? t("kind.streamStart", { name })
      : anniversaryYears !== null
      ? t("kind.friendAnniversary", { name, count: anniversaryYears })
      : isReaction
      ? t("kind.reaction", { name, emoji: typeof n.payload.emoji === "string" ? n.payload.emoji : "" })
      : isProfileUpdate
      ? t("kind.profileUpdate", { name })
      : n.kind === "system" && typeof n.payload.title === "string"
      ? n.payload.title
      : t(KIND_KEY[n.kind], { name, channel });
  const preview =
    isReaction || isIncomingMessage ? "" : n.kind === "system"
      ? typeof n.payload.body === "string" ? n.payload.body : ""
      : typeof n.payload.preview === "string" ? n.payload.preview : "";
  const isUnread = n.read_at === null;

  return (
    <button
      type="button"
      className={`notif-row${isUnread ? " unread" : ""}`}
      onClick={() => onOpen(n)}
    >
      <Avatar name={name} avatarUrl={n.actor?.avatar_url ?? null} size={32} isCircle />
      <span className="notif-row-body">
        <span className="notif-row-headline">{headline}</span>
        {preview && <span className="notif-row-preview">{preview}</span>}
        <span className="notif-row-time">{formatRelativePast(n.created_at, i18n.language)}</span>
      </span>
      {isUnread && <span className="notif-row-dot" aria-hidden="true" />}
    </button>
  );
}

export default NotificationItem;
