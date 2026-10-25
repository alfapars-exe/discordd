import { useEffect, useState } from "react";
import VoiceOverlayContent, { type VoiceOverlaySnapshot } from "./VoiceOverlayContent";

export default function VoiceOverlayApp() {
  const [snapshot, setSnapshot] = useState<VoiceOverlaySnapshot | null>(null);
  const [actionsOnly] = useState(() => new URLSearchParams(window.location.search).get("surface") === "actions");
  const [notificationActionsOnly] = useState(() => new URLSearchParams(window.location.search).get("surface") === "notification-actions");
  const [chatActionsOnly] = useState(() => new URLSearchParams(window.location.search).get("surface") === "chat-actions");
  const [chatComposerOnly] = useState(() => new URLSearchParams(window.location.search).get("surface") === "chat-composer");
  useEffect(() => window.electronAPI?.onVoiceOverlayUpdate?.((value) => setSnapshot(value as VoiceOverlaySnapshot)), []);
  return snapshot ? <VoiceOverlayContent snapshot={snapshot} actionsOnly={actionsOnly} notificationActionsOnly={notificationActionsOnly} chatActionsOnly={chatActionsOnly} chatComposerOnly={chatComposerOnly} /> : null;
}
