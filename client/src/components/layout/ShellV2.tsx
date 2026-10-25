import { useEffect, type ComponentProps } from "react";
import { useTranslation } from "react-i18next";
import { useIsMobile, useIsTablet } from "../../hooks/useMediaQuery";
import { useUIStore } from "../../stores/uiStore";
import Sidebar from "./Sidebar";
import MemberList from "./MemberList";
import MobileAppLayout from "./MobileAppLayout";
import DestinationView from "./DestinationView";

/** Responsive presentation only; all connection owners stay in AppLayout. */
export default function ShellV2({ sidebarProps, sendTyping, sendDMTyping }: {
  sidebarProps: ComponentProps<typeof Sidebar>;
  sendTyping: (id: string) => void;
  sendDMTyping: (id: string) => void;
}) {
  const { t } = useTranslation("common");
  const mobile = useIsMobile();
  const tablet = useIsTablet();
  const hasMembers = useUIStore((s) => !!s.destination.serverInfo);
  const membersOpen = useUIStore((s) => s.membersOpen);
  useEffect(() => {
    if (tablet) useUIStore.setState({ membersOpen: false });
  }, [tablet]);
  if (mobile) return <MobileAppLayout sidebarProps={sidebarProps} sendTyping={sendTyping} sendDMTyping={sendDMTyping} />;
  return <div className="mqvi-app ui-shell-v2">
    <Sidebar {...sidebarProps} />
    <main className="shell-workspace">
      <DestinationView sendTyping={sendTyping} sendDMTyping={sendDMTyping} onJoinVoice={sidebarProps.onJoinVoice} />
      {hasMembers && <>
        {tablet && membersOpen && <button className="shell-members-backdrop" aria-label={t("close")} onClick={() => useUIStore.getState().toggleMembers()} />}
        <MemberList />
      </>}
    </main>
  </div>;
}
