import type { ShortcutContext } from "./shortcutRegistry";
export const shortcutContextLabels: Record<ShortcutContext, string> = {
  inbox: "shortcutInboxScope",
  message: "shortcutMessageFocus",
  drag: "shortcutDragFocus",
  "incoming-call": "shortcutIncomingCallScope",
  voice: "shortcutVoiceScope",
};
