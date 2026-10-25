import { useTranslation } from "react-i18next";
import "../../styles/voice-overlay.css";

type VoiceWidgetPosition = "top-left" | "center-left" | "bottom-left" | "top-right" | "bottom-right";
type Props = {
  enabled: boolean;
  mode: "desktop" | "game";
  speakingOpacity: number;
  idleOpacity: number;
  scale: number;
  position: VoiceWidgetPosition;
  speakingOnly: boolean;
  avatarSize: "small" | "large";
  nameDisplay: "always" | "speaking" | "never";
  maxParticipants: number;
};

const SAMPLE_PARTICIPANTS = [
  { id: "sample-speaking", nameKey: "voiceOverlaySampleUserOne", speaking: true, muted: false, deafened: false },
  { id: "sample-muted", nameKey: "voiceOverlaySampleUserTwo", speaking: false, muted: true, deafened: false },
  { id: "sample-deafened", nameKey: "voiceOverlaySampleUserThree", speaking: false, muted: false, deafened: true },
] as const;

export default function VoiceWidgetPreview(props: Props) {
  const { t } = useTranslation("settings");
  const participants = SAMPLE_PARTICIPANTS
    .filter((participant) => !props.speakingOnly || participant.speaking)
    .slice(0, Math.max(0, Math.min(25, Math.floor(props.maxParticipants))));
  const transformOrigin = `${props.position === "center-left" ? "center" : props.position.startsWith("top") ? "top" : "bottom"} ${props.position.endsWith("left") ? "left" : "right"}`;

  return <section className="voice-widget-preview" aria-labelledby="voice-widget-preview-title">
    <div className="voice-widget-preview-heading">
      <h3 id="voice-widget-preview-title">{t("voiceOverlayPreviewTitle")}</h3>
      <p>{t("voiceOverlayPreviewDescription")}</p>
      <span className="voice-widget-preview-sample">{t("voiceOverlayPreviewSample")}</span>
    </div>
    <div className={`voice-widget-preview-stage position-${props.position}`} data-overlay-mode={props.mode} role="img" aria-label={t("voiceOverlayPreviewAria")}>
      <div className="voice-widget-preview-widget" data-avatar-size={props.avatarSize} style={{ transform: `scale(${props.scale / 100})`, transformOrigin }}>
        {props.enabled && props.maxParticipants > 0 ? participants.map((participant) => (
          <div key={participant.id} className={`voice-overlay-row${participant.speaking ? " speaking" : ""}`}
            style={{ opacity: (participant.speaking ? props.speakingOpacity : props.idleOpacity) / 100 }}>
            <div className="voice-overlay-avatar" aria-hidden="true">{t(participant.nameKey).charAt(0)}</div>
            {props.nameDisplay !== "never" && (props.nameDisplay !== "speaking" || participant.speaking) && <span>{t(participant.nameKey)}</span>}
            {(participant.muted || participant.deafened) && <b aria-hidden="true">{participant.deafened ? "◉" : "⌁"}</b>}
          </div>
        )) : <span className="voice-widget-preview-disabled">{props.enabled ? t("voiceOverlayMaxParticipantsOff") : t("voiceOverlayPreviewDisabled")}</span>}
      </div>
    </div>
  </section>;
}
