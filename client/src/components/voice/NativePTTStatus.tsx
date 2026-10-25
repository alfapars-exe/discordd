import {useTranslation}from "react-i18next";
export default function NativePTTStatus({unavailable,retry}:{unavailable:boolean;retry:()=>void}){
 const{t}=useTranslation("voice");
 return unavailable?<div role="alert"><p>{t("backgroundPTTUnavailable")}</p><button type="button" onClick={retry}>{t("p2pAudioRetry")}</button></div>:null;
}
