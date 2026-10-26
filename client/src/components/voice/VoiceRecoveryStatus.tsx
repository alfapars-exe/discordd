import { useTranslation } from "react-i18next";
import { useVoiceRecoveryStore } from "../../stores/voiceRecoveryStore";

/** Outside Room context so it remains available after failed media is disposed. */
export default function VoiceRecoveryStatus() {
  const { t } = useTranslation("voice");
  const { phase, kind, attempt, retry, leave } = useVoiceRecoveryStore();
  if (phase === "idle") return null;
  const key = phase === "offline" ? "recoveryOffline"
    : phase === "failed" ? kind === "unsupported" ? "recoveryUnsupported"
      : kind === "access" ? "recoveryAccess" : kind === "session" ? "recoverySession" : "recoveryFailed"
    : kind.startsWith("encryption") ? "recoveryEncryption" : "recoveryConnection";
  return <section className="voice-recovery-status" role="status" aria-live="polite" aria-atomic="true">
    <p>{t(key, { attempt, max: 3 })}</p>
    {phase === "failed" && retry && <button type="button" onClick={retry}>{t("recoveryRetry")}</button>}
    {leave && <button type="button" onClick={leave}>{t("disconnect")}</button>}
  </section>;
}
