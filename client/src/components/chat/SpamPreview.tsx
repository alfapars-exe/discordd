import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useSpamVisibility } from "../../hooks/useSpamVisibility";
import { useIgnoredMessage } from "../../hooks/useIgnoredMessage";

export default function SpamPreview({ message, kind, children }: {
  message: { id: string; user_id: string; content: string | null; edited_at?: string | null };
  kind: "channel" | "dm" | "group";
  children?: ReactNode;
}) {
  const { t } = useTranslation("chat");
  const spam = useSpamVisibility(message, { kind, channelId: "" });
  const { ignored } = useIgnoredMessage(message.user_id);
  return <>{spam.pending?t("spamFilterPending"):spam.hidden ? t("spamHidden") : ignored ? t("ignoredMessage") : children ?? message.content}</>;
}
