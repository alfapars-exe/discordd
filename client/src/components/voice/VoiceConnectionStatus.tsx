import { useVoiceRecoveryStore } from "../../stores/voiceRecoveryStore";
/** VoiceConnectionStatus — LiveKit connection state indicator. Hidden when connected. */

import { useMaybeRoomContext, useConnectionState } from "@livekit/components-react";
import { ConnectionState } from "livekit-client";
import { useTranslation } from "react-i18next";
import { isNativeVoice } from "../../utils/nativePlugins";

function LiveVoiceConnectionStatus({ showConnected = false }: { showConnected?: boolean }) {
  const { t } = useTranslation("voice");
  const connectionState = useConnectionState();
  const recoveryPhase = useVoiceRecoveryStore(s => s.phase);
  if (recoveryPhase !== "idle") return null;

  // iOS native voice: connection is handled natively, JS SDK isn't connected — hide status
  if (isNativeVoice()) return showConnected ? <span className="ub-voice-label">{t("voiceConnected")}</span> : null;

  if (connectionState === ConnectionState.Connected) {
    return showConnected ? <span className="ub-voice-label" role="status">{t("voiceConnected")}</span> : null;
  }

  const statusConfig: Record<string, { message: string; dotClass: string; textClass: string }> = {
    [ConnectionState.Connecting]: {
      message: t("connectingToVoice"),
      dotClass: "voice-connection-dot connecting",
      textClass: "voice-connection-text warning",
    },
    [ConnectionState.Reconnecting]: {
      message: t("reconnectingToVoice"),
      dotClass: "voice-connection-dot connecting",
      textClass: "voice-connection-text warning",
    },
    [ConnectionState.Disconnected]: {
      message: t("voiceDisconnectedHint"),
      dotClass: "voice-connection-dot error",
      textClass: "voice-connection-text error",
    },
  };

  const config = statusConfig[connectionState] ?? {
    message: connectionState,
    dotClass: "voice-connection-dot",
    textClass: "voice-connection-text muted",
  };

  return (
    <div className="voice-connection-status" role="status" aria-live="polite">
      <span className={config.dotClass} />
      <span className={config.textClass}>{config.message}</span>
    </div>
  );
}

export default function VoiceConnectionStatus(props: { showConnected?: boolean }) {
  const room = useMaybeRoomContext();
  const phase = useVoiceRecoveryStore(s => s.phase);
  return room && phase === "idle" ? <LiveVoiceConnectionStatus {...props} /> : null;
}
