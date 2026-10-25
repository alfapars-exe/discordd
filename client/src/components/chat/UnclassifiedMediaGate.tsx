import { useCallback, useContext, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ChatContext } from "../../hooks/useChatContext";
import { usePreferencesStore } from "../../stores/preferencesStore";
import { useFriendStore } from "../../stores/friendStore";
import { useAuthStore } from "../../stores/authStore";
import { annotatedMediaMode, automaticMediaMode, unknownMediaMode, type MediaPolicy, type MediaScope } from "../../utils/mediaVisibility";
import PrivateMediaAnnotation, { type MediaAnnotationSource } from "./PrivateMediaAnnotation";
import { useE2EEStore } from "../../stores/e2eeStore";
import { useLocalMediaAnalysis, type LocalMediaInput } from "../../hooks/useLocalMediaAnalysis";
import { useLightboxStore } from "../../stores/lightboxStore";
import { getAuthGeneration } from "../../api/client";

export default function UnclassifiedMediaGate({ authorId, identity, privateConversation, messageId, revision = "original", sourceKind, sourceChannelId, mediaInputs = [], children }: { authorId: string; identity: string; privateConversation?: boolean; messageId?: string; revision?: string; sourceKind?: MediaAnnotationSource["source_kind"]; sourceChannelId?: string; mediaInputs?:readonly LocalMediaInput[]; children: ReactNode }) {
  const context = useContext(ChatContext);
  const privacy = usePreferencesStore((s) => s.get<{ sensitiveMedia?: MediaPolicy; disturbingMedia?: MediaPolicy }>("privacy"));
  const friends = useFriendStore((s) => s.friends);
  const userId = useAuthStore((s) => s.user?.id);
  const generation = useAuthStore(() => getAuthGeneration());
  const deviceId = useE2EEStore((s) => s.localDeviceId);
  const [revealed, setRevealed] = useState<string | null>(null);
  const resetVisibility = useCallback(() => { setRevealed(null); if(messageId&&useLightboxStore.getState().item?.messageId===messageId)useLightboxStore.getState().close(); }, [messageId]);
  const scope: MediaScope = (privateConversation ?? context?.mode === "dm") ? friends.some((friend) => friend.user_id === authorId) ? "friendDMs" : "otherDMs" : "channels";
  const source = messageId && (sourceChannelId || context?.channelId) ? { source_kind: sourceKind ?? context?.mode ?? "channel", channel_id: sourceChannelId || context!.channelId, message_id: messageId, revision } : undefined;
  const renderMedia = (label?: Parameters<typeof annotatedMediaMode>[2], canAnalyze = true) => <AnalyzedMediaContent key={JSON.stringify([userId,generation,deviceId,identity,revision,label])} own={authorId===userId} canAnalyze={canAnalyze} label={label} privacy={privacy} scope={scope} mediaInputs={mediaInputs} revealed={revealed} revealIdentity={`${userId}:${generation}:${deviceId}:${identity}:${revision}`} setRevealed={setRevealed} resetVisibility={resetVisibility}>{children}</AnalyzedMediaContent>;
  return source && userId && authorId !== userId ? <PrivateMediaAnnotation key={JSON.stringify([userId, generation, deviceId, source, identity])} source={source} identity={identity} owner={userId} onVisibilityReset={resetVisibility}>{renderMedia}</PrivateMediaAnnotation> : renderMedia();
}

function AnalyzedMediaContent({own,canAnalyze,label,privacy,scope,mediaInputs,revealed,revealIdentity,setRevealed,resetVisibility,children}:{own:boolean;canAnalyze:boolean;label?:string;privacy:{sensitiveMedia?:MediaPolicy;disturbingMedia?:MediaPolicy}|undefined;scope:MediaScope;mediaInputs:readonly LocalMediaInput[];revealed:string|null;revealIdentity:string;setRevealed:(value:string)=>void;resetVisibility:()=>void;children:ReactNode}) {
  const {t}=useTranslation("chat");
  const analysis=useLocalMediaAnalysis(mediaInputs,canAnalyze&&!own&&!label&&unknownMediaMode(privacy,scope)!=="show",resetVisibility);
  const mode=own?"show":label?annotatedMediaMode(privacy,scope,label):automaticMediaMode(privacy,scope,analysis.analysis);
  const revealKey=`${revealIdentity}:${scope}:${mode}:${label??"unknown"}:${analysis.status}:${analysis.analysis?.sexual??"unknown"}:${analysis.analysis?.disturbing??"unknown"}`;
  const visible=mode==="show"||(mode==="blur"&&revealed===revealKey);
  return <>
    {visible?children:<div className="msg-attachment-file" role="note"><div><p>{t(label?mode==="block"?"mediaSafetyLabeledBlocked":"mediaSafetyLabeledHidden":mode==="block"?"mediaSafetyBlocked":"mediaSafetyUnknown")}</p>{mode==="blur"&&<button type="button" onClick={()=>setRevealed(revealKey)}>{t("mediaSafetyReveal")}</button>}</div></div>}
    {analysis.status==="loading"&&<p role="status">{t("mediaAnalysisLoading")}</p>}
    {analysis.status==="ready"&&<>
      {analysis.analysis?.frameSampling&&<p>{t("mediaAnalysisFramesSampled",{sampled:analysis.analysis.frameSampling.sampledFrameCount,total:analysis.analysis.frameSampling.totalFrameCount})}</p>}
      {analysis.analysis?.videoSampling&&<p>{t("mediaAnalysisVideoSampled",{sampled:analysis.analysis.videoSampling.sampledFrameCount,duration:Math.ceil(analysis.analysis.videoSampling.durationSeconds)})}</p>}
      {!analysis.analysis?.frameSampling&&!analysis.analysis?.videoSampling&&<p>{t(analysis.analysis?.disturbing==="unknown"?"mediaAnalysisPartial":"mediaAnalysisLocal")}</p>}
    </>}
    {analysis.status==="error"&&<div role="status"><p>{t("mediaAnalysisUnknown")}</p><button type="button" onClick={analysis.retry}>{t("mediaAnalysisRetry")}</button></div>}
  </>;
}
