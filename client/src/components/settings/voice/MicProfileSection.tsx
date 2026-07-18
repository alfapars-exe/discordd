/**
 * MicProfileSection — Konuşma / Müzik microphone profile toggle.
 *
 * Picking a profile only writes to the store. useMicSync watches it and runs
 * an unpublish/republish cycle on the mic track (no room reconnect), honouring
 * mute / server-mute / push-to-talk state — which is why this component never
 * touches the LiveKit SDK directly.
 *
 * The Müzik warning is not decoration: that profile turns off noise
 * suppression, echo cancellation and AGC, so anyone selecting it on a laptop
 * mic in a live channel will echo. It has to be visible before the click, not
 * discovered afterwards.
 */

import { useTranslation } from "react-i18next";
import { useVoiceStore } from "../../../stores/voiceStore";
import type { MicProfile } from "../../../stores/slices/voiceSettingsSlice";

function MicProfileSection() {
  const { t } = useTranslation("settings");

  const micProfile = useVoiceStore((s) => s.micProfile);
  const setMicProfile = useVoiceStore((s) => s.setMicProfile);

  const options: { value: MicProfile; title: string; desc: string }[] = [
    {
      value: "konusma",
      title: t("micProfileSpeech"),
      desc: t("micProfileSpeechDesc"),
    },
    {
      value: "muzik",
      title: t("micProfileMusic"),
      desc: t("micProfileMusicDesc"),
    },
  ];

  return (
    <div className="vs-section">
      <div className="vs-label">{t("micProfile")}</div>
      <div className="vs-desc" style={{ marginBottom: 10 }}>
        {t("micProfileDesc")}
      </div>

      <div className="vs-radio-group">
        {options.map((opt) => (
          <button
            key={opt.value}
            className={`vs-radio${micProfile === opt.value ? " active" : ""}`}
            onClick={() => setMicProfile(opt.value)}
            aria-pressed={micProfile === opt.value}
          >
            <div className="vs-radio-dot" />
            <div>
              <div className="vs-radio-title">{opt.title}</div>
              <div className="vs-desc">{opt.desc}</div>
            </div>
          </button>
        ))}
      </div>

      {micProfile === "muzik" && (
        <div className="vs-desc vs-warning">{t("micProfileMusicWarning")}</div>
      )}
    </div>
  );
}

export default MicProfileSection;
