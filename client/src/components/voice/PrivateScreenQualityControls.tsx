import {isElectron}from "../../utils/constants";
import { useTranslation } from "react-i18next";
import { useVoiceStore } from "../../stores/voiceStore";
export default function PrivateScreenQualityControls({audio}:{audio?:{enabled:boolean;disabled?:boolean;onChange:(value:boolean)=>void}}={}) {
 const {t}=useTranslation("voice");
 const quality=useVoiceStore(state=>state.screenShareQuality),fps=useVoiceStore(state=>state.screenShareFps);
 const setQuality=useVoiceStore(state=>state.setScreenShareQuality),setFps=useVoiceStore(state=>state.setScreenShareFps);
 const lowLatency=useVoiceStore(state=>state.screenShareLowLatency),setLowLatency=useVoiceStore(state=>state.setScreenShareLowLatency);
 const mode=useVoiceStore(state=>state.screenShareMode),setMode=useVoiceStore(state=>state.setScreenShareMode);
 return <span className="private-screen-quality">
  <label>{t("privateScreenQuality")}<select value={quality} onChange={event=>setQuality(event.target.value as typeof quality)}><option value="720p">720p</option><option value="1080p">1080p</option><option value="1440p">1440p</option><option value="native">{t("privateScreenNative")}</option></select></label>
  <label>FPS<select aria-label={t("privateScreenFps")} value={fps} onChange={event=>setFps(Number(event.target.value) as typeof fps)}><option value={30}>30</option><option value={60}>60</option><option value={120}>120</option>{fps===-1&&<option value={-1}>{t("privateScreenNativeRate")}</option>}</select></label>
  <label>{t("screenShareMode",{ns:"settings"})}<select value={mode} onChange={event=>setMode(event.target.value as typeof mode)}><option value="motion">{t("screenShareModeMotion",{ns:"settings"})}</option><option value="detail">{t("screenShareModeDetail",{ns:"settings"})}</option></select></label>
  <label title={t("screenShareLowLatencyHint",{ns:"settings"})}><input type="checkbox" checked={lowLatency} onChange={event=>setLowLatency(event.target.checked)}/>{t("screenShareLowLatency",{ns:"settings"})}</label>
  {audio?<label><input type="checkbox" checked={audio.enabled} disabled={audio.disabled} onChange={event=>audio.onChange(event.target.checked)}/>{t(isElectron()?"privateScreenAudioWindowsConsent":"privateScreenAudioBrowserConsent")}</label>:null}
 </span>;
}
