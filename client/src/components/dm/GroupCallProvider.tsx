import { lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";
import { isCurrentGroupCall, useGroupCallStore } from "../../stores/groupCallStore";
import { useUIStore } from "../../stores/uiStore";
import "./GroupCallProvider.css";
import SectionErrorBoundary from "../shared/SectionErrorBoundary";
const GroupDMCall=lazy(()=>import("./GroupDMCall"));

/** One app-level media owner; never key this component by the visible chat. */
export default function GroupCallProvider(){
 const {t}=useTranslation("voice"),{t:common}=useTranslation("common");
 const session=useGroupCallStore(s=>s.session);
 if(!session||!isCurrentGroupCall(session.nonce))return null;
 const leave=()=>useGroupCallStore.getState().leave(session.nonce);
 const returnToCall=()=>{if(isCurrentGroupCall(session.nonce))useUIStore.getState().openTab(session.groupId,"group-dm",session.label)};
 return <aside className="app-group-call" aria-label={session.label}>
  <header><strong>{session.label}</strong><button type="button" onClick={returnToCall}>{t("returnToCall")}</button><button type="button" onClick={leave}>{common("leaveCall")}</button></header>
  {session.phase==="requesting"&&<p role="status">{t(session.credentials?"reconnectingToVoice":"connectingToVoice")}</p>}
  {session.phase==="error"&&<div role="alert"><p>{common("somethingWentWrong")}</p><button type="button" onClick={()=>useGroupCallStore.getState().retry(session.nonce)}>{common("retry")}</button></div>}
  {session.credentials&&<SectionErrorBoundary key={session.nonce} section="group-call"><Suspense fallback={<p role="status">{t("connectingToVoice")}</p>}><GroupDMCall key={session.nonce} credentials={session.credentials} callSessionNonce={session.nonce} initialMicrophoneEnabled={!session.manualMuted} isCurrentSession={()=>isCurrentGroupCall(session.nonce)} onLeave={leave}/></Suspense></SectionErrorBoundary>}
 </aside>;
}
