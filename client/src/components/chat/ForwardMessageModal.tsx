import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { getChannels } from "../../api/channels";
import { getAuthSessionSnapshot } from "../../api/authSessionEvents";
import { decryptFile } from "../../crypto/fileEncryption";
import { useDMStore } from "../../stores/dmStore";
import { useMessageStore } from "../../stores/messageStore";
import { useServerStore } from "../../stores/serverStore";
import { useToastStore } from "../../stores/toastStore";
import { resolveAssetUrl } from "../../utils/constants";
import { useAuthStore } from "../../stores/authStore";
import { useComposerDraftStore } from "../../stores/composerDraftStore";
import {buildForwardContent,canForwardToChannel,type ForwardableMessage} from "./forwardMessageContent";
import {useGroupDMStore} from "../../stores/groupDMStore";
import {groupAttachmentKeyIndex} from "../../utils/groupAttachmentKeys";

type Destination = { kind: "channel" | "dm" | "group"; id: string; serverId?: string; label: string; detail: string };
type Props = { message: ForwardableMessage; onClose: () => void };

async function materializeAttachments(message: ForwardableMessage,isCurrent:()=>boolean): Promise<File[]> {
  return Promise.all(message.attachments.map(async (attachment, index) => {
    if(!isCurrent())throw new Error("forward_context_changed");
    const keyIndex=groupAttachmentKeyIndex(attachment,index);
    const meta = keyIndex===undefined?undefined:message.e2ee_file_keys?.[keyIndex];
    if ((message.encryption_version ?? 0) > 0) {
      if (!meta) throw new Error("missing_encrypted_file_key");
      return decryptFile(resolveAssetUrl(attachment.file_url), meta);
    }
    const response = await fetch(resolveAssetUrl(attachment.file_url), { credentials: "include" });
    if (!response.ok) throw new Error(`attachment_download_${response.status}`);
    const blob = await response.blob();
    return new File([blob], attachment.filename, { type: attachment.mime_type ?? blob.type });
  }));
}

export default function ForwardMessageModal({ message, onClose }: Props) {
  const { t } = useTranslation("chat");
  const servers = useServerStore((state) => state.servers);
  const dmChannels = useDMStore((state) => state.channels);
  const fetchDMs = useDMStore((state) => state.fetchChannels);
  const groups=useGroupDMStore(state=>state.groups);
  const pendingGroups=useGroupDMStore(state=>state.pendingSends);
  const [channelTargets, setChannelTargets] = useState<Destination[]>([]);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError,setLoadError]=useState(false);
  const [loadRevision,setLoadRevision]=useState(0);
  const owner=useRef({id:useAuthStore.getState().user?.id,generation:useComposerDraftStore.getState().generation,authGeneration:getAuthSessionSnapshot().generation});
  const live=useRef(false),sending=useRef(false),source=useRef(message);
  useLayoutEffect(()=>{source.current=message},[message]);
  const isOwner=useCallback(()=>Boolean(owner.current.id&&useAuthStore.getState().user?.id===owner.current.id&&useComposerDraftStore.getState().generation===owner.current.generation),[]);
  const close=useCallback(()=>{if(!live.current)return;live.current=false;onClose()},[onClose]);
  useEffect(()=>{live.current=true;return()=>{live.current=false}},[]);

  useEffect(()=>{
    const unwatchAccount=useAuthStore.subscribe((state,previousState)=>{
      if(state.user?.id!==previousState.user?.id)close();
    });
    const unwatchGeneration=useComposerDraftStore.subscribe((state,previousState)=>{
      if(state.generation!==previousState.generation)close();
    });
    return()=>{unwatchAccount();unwatchGeneration()};
  },[close]);

  useEffect(()=>{
    const handleKeyDown=(event:KeyboardEvent)=>{
      if(event.key==="Escape")close();
    };
    document.addEventListener("keydown",handleKeyDown);
    return()=>document.removeEventListener("keydown",handleKeyDown);
  },[close]);

  useEffect(() => {
    let current = true;
    void (async () => {
      if(!live.current||!isOwner())return;
      let failed=false;
      if (dmChannels.length === 0){try{if(await fetchDMs()===false)failed=true}catch{failed=true}}
      if(!current||!live.current||!isOwner())return;
      if(!useGroupDMStore.getState().groupsReady){try{await useGroupDMStore.getState().fetchGroups();if(!useGroupDMStore.getState().groupsReady)failed=true}catch{failed=true}}
      if(!current||!live.current||!isOwner())return;
      const results = await Promise.allSettled(servers.map(async (server) => ({ server, result: await getChannels(server.id) })));
      if (!current || !live.current || !isOwner()) return;
      setChannelTargets(results.flatMap(outcome=>{
        if(outcome.status!=="fulfilled"){failed=true;return []}
        const {server,result}=outcome.value;
        if(!result.success||!result.data){failed=true;return []}
        return result.data.flatMap((group) => group.channels
            .filter((channel) => {if(channel.type!=="text")return false;if(channel.effective_permissions===undefined)failed=true;return canForwardToChannel(channel)})
            .map((channel) => ({ kind: "channel" as const, id: channel.id, serverId: server.id, label: `#${channel.name}`, detail: server.name })));
      }));
      setLoadError(failed);
      setLoading(false);
    })().catch(()=>{if(current&&live.current&&isOwner()){setChannelTargets([]);setLoadError(true);setLoading(false)}});
    return () => { current = false; };
  }, [dmChannels.length, fetchDMs, servers,isOwner,loadRevision]);

  const destinations = useMemo(() => {
    const dms: Destination[] = dmChannels
      .filter((channel) => channel.status === "accepted")
      .map((channel) => ({
        kind: "dm", id: channel.id,
        label: channel.other_user.display_name ?? channel.other_user.username,
        detail: t("directMessages"),
      }));
    const normalized = query.trim().toLocaleLowerCase();
    const groupTargets:Destination[]=groups.map(group=>({kind:"group",id:group.id,label:group.name,detail:t("forwardGroupChats")}));
    return [...dms,...groupTargets, ...channelTargets].filter((destination) =>
      !normalized || `${destination.label} ${destination.detail}`.toLocaleLowerCase().includes(normalized));
  }, [channelTargets, query, t, dmChannels,groups]);

  const forward = async (destination: Destination) => {
    if(sending.current||!live.current||!isOwner())return;
    sending.current=true;
    const original=message;
    const isCurrent=()=>live.current&&isOwner()&&source.current===original;
    setBusy(`${destination.kind}:${destination.id}`);
    try {
      const files = await materializeAttachments(message,isCurrent);
      if(!isCurrent())return;
      if(destination.kind==="channel"){
        const latest=await getChannels(destination.serverId!,{isCurrent});
        if(!isCurrent())return;
        if(!latest.success||!latest.data?.some(group=>group.channels.some(channel=>channel.id===destination.id&&canForwardToChannel(channel))))throw new Error("forward_permission_changed");
      }else if(destination.kind==="group"){
        await useGroupDMStore.getState().fetchGroups();if(!isCurrent())return;
        const refreshed=useGroupDMStore.getState();
        if(refreshed.error||!refreshed.groupsReady||!refreshed.groups.some(group=>group.id===destination.id)||refreshed.pendingSends[destination.id])throw new Error("forward_destination_changed");
        await refreshed.restorePendingSends();if(!isCurrent())return;
      }else if(!useDMStore.getState().channels.some(channel=>channel.id===destination.id&&channel.status==="accepted"))throw new Error("forward_destination_changed");
      const content = buildForwardContent(message, t("forwardedFrom"));
      // Keep the original forwarding intent fenced through asynchronous encryption/uploads.
      const context={ownerId:owner.current.id!,authGeneration:owner.current.authGeneration,isCurrent};
      const ok = destination.kind === "channel"
        ? await useMessageStore.getState().sendMessage(destination.id, content, files, undefined, destination.serverId, context)
        : destination.kind==="group"?await useGroupDMStore.getState().send(destination.id,content,undefined,files,context):await useDMStore.getState().sendMessage(destination.id, content, files, undefined, context);
      if (!ok) throw new Error("send_failed");
      if(!isCurrent())return;
      const recovery=destination.kind==="group"&&(useGroupDMStore.getState().pendingSends[destination.id]||(useGroupDMStore.getState().uploadRecoveries[destination.id]?.length??0)>0);
      useToastStore.getState().addToast(recovery?"warning":"success", recovery?t("forwardGroupRecovery"):t("forwardSuccess", { destination: destination.label }));
      close();
    } catch {
      if(!isCurrent())return;
      const groupPending=destination.kind==="group"&&useGroupDMStore.getState().pendingSends[destination.id];
      useToastStore.getState().addToast(groupPending?"warning":"error", t(groupPending?"forwardGroupPending":"forwardFailed"));
    }finally{
      sending.current=false;
      // A source replacement cancels the old send without closing the dialog.
      // Its early-return path must release the visible destination lock too.
      if(live.current&&isOwner())setBusy(null);
    }
  };

  return (
    <div className="report-overlay" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) close(); }}>
      <div className="report-modal forward-modal" role="dialog" aria-modal="true" aria-labelledby="forward-title">
        <div className="report-header">
          <h2 id="forward-title" className="report-title">{t("forwardMessage")}</h2>
          <button className="report-close" onClick={close} aria-label={t("forwardClose")}>✕</button>
        </div>
        <div className="report-body">
          <input className="forward-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("forwardSearch")} autoFocus />
          <p className="forward-security-note">{t("forwardSecurityNote")}</p>
          {loadError&&<div role="alert"><p>{t("forwardTargetsFailed")}</p><button type="button" disabled={loading||busy!==null} onClick={()=>{setLoading(true);setLoadError(false);setLoadRevision(value=>value+1)}}>{t("forwardTargetsRetry")}</button></div>}
          <div className="forward-destinations">
            {loading ? <p>{t("forwardLoading")}</p> : destinations.length === 0 ? loadError?null:<p>{t("forwardEmpty")}</p> : destinations.map((destination) => {
              const key = `${destination.kind}:${destination.id}`;
              return (
                <button key={key} className="forward-destination" disabled={busy !== null||(destination.kind==="group"&&Boolean(pendingGroups[destination.id]))} onClick={() => { void forward(destination); }}>
                  <span><strong>{destination.label}</strong><small>{destination.detail}</small></span>
                  <span>{busy === key ? t("forwardSending") : t("forwardSend")}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
