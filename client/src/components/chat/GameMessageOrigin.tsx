import { useTranslation } from "react-i18next";

/** The persisted origin is supplied by the server, never inferred from a name. */
export default function GameMessageOrigin({ applicationID, authorID }: { applicationID?: string | null; authorID: string }) {
  const { t } = useTranslation("chat");
  if (!applicationID || applicationID !== authorID) return null;
  return <span className="msg-game-origin" title={t("gameMessageOriginHint", { id: applicationID })} style={{ fontSize: "0.75em", border: "1px solid currentColor", borderRadius: 4, padding: "1px 4px" }}>{t("gameMessageOrigin")}</span>;
}
