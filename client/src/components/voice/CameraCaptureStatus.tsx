import {useTranslation}from "react-i18next";
import type{CameraStatus}from "../../audio/ownedCamera";
export default function CameraCaptureStatus({status,retry}:{status:CameraStatus;retry:()=>void}){const{t}=useTranslation("settings");return status.phase==="error"?<div role="alert"><p>{t(status.error??"cameraError")}</p><button type="button" onClick={retry}>{t("cameraRetry")}</button></div>:status.phase==="starting"?<p role="status">{t("cameraStarting")}</p>:null;}
