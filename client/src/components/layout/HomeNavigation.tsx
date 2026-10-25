import { useTranslation } from "react-i18next";
import { useUIStore, type TabType } from "../../stores/uiStore";
import { IconFriends, IconInbox, IconBell } from "../shared/Icons";

const entries = [
  { type: "friends", key: "friends", Icon: IconFriends },
  { type: "inbox", key: "shellInbox", Icon: IconInbox },
  { type: "notifications", key: "shellNotifications", Icon: IconBell },
] as const;
export default function HomeNavigation() {
  const { t } = useTranslation("common");
  const current = useUIStore((s) => s.destination.type);
  function open(type: TabType, label: string) {
    useUIStore.getState().navigate({ type, channelId: type, label });
  }
  return <nav className="home-navigation" aria-label={t("navigation")}>
    {entries.map(({ type, key, Icon }) => <button key={type} aria-current={current === type ? "page" : undefined} onClick={() => open(type, t(key))}>
      <Icon width={20} height={20} /><span>{t(key)}</span>
    </button>)}
    <button aria-current={current === "saved" ? "page" : undefined} onClick={() => open("saved", t("shellSaved"))}>
      <svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.7" aria-hidden="true"><path d="M6 3h12v18l-6-4-6 4z" /></svg><span>{t("shellSaved")}</span>
    </button>
  </nav>;
}
