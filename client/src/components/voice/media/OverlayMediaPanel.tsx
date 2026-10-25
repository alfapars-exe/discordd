import {parseOverlayMediaEnvelope} from "../../../../../electron/overlay-media-contract";
import {useEffect,useRef,useState} from "react";
import {useTranslation} from "react-i18next";
import {createOverlayMediaReceiver,type OverlayMediaBridge,type OverlayReceivedVideo} from "../../../video/overlayMediaBridge";
import {parseOverlayLease,type OverlayLease,type OverlayTile} from "../../../utils/overlayMediaUIContract";
function VideoTile({tile,track,lease}:{tile:OverlayTile;track?:MediaStreamTrack;lease:OverlayLease}){
 const {t}=useTranslation("settings"),root=useRef<HTMLDivElement>(null),video=useRef<HTMLVideoElement>(null);
 const [failedTrack,setFailedTrack]=useState<MediaStreamTrack|null>(null);
 useEffect(()=>{const element=video.current;if(!element||!track)return;const stream=new MediaStream([track]);let active=true;element.muted=true;element.srcObject=stream;void element.play().catch(()=>{if(active)setFailedTrack(track)});return()=>{active=false;element.pause();element.srcObject=null}},[track]);
 useEffect(()=>{
  const element=root.current,api=window.electronAPI;if(!element||!api?.sendOverlayMediaViewport)return;let active=true,intersecting=false;
  const send=()=>{if(!active)return;const box=element.getBoundingClientRect(),visible=failedTrack!==track&&document.visibilityState==="visible"&&intersecting&&box.width>0&&box.height>0;void api.sendOverlayMediaViewport!({session:lease.session,revision:lease.revision,tileId:tile.tileId,visible,width:visible?Math.min(1920,Math.ceil(box.width)):0,height:visible?Math.min(1080,Math.ceil(box.height)):0,fps:visible?30:0}).catch(()=>{})};
  const resize=typeof ResizeObserver!=="undefined"?new ResizeObserver(send):null;
  const intersection=typeof IntersectionObserver!=="undefined"?new IntersectionObserver(entries=>{intersecting=entries.some(entry=>entry.target===element&&entry.isIntersecting);send()}):null;
  resize?.observe(element);intersection?.observe(element);if(!intersection){const box=element.getBoundingClientRect();intersecting=box.bottom>0&&box.right>0&&box.top<innerHeight&&box.left<innerWidth;}
  document.addEventListener("visibilitychange",send);window.addEventListener("resize",send);send();
  return()=>{active=false;resize?.disconnect();intersection?.disconnect();document.removeEventListener("visibilitychange",send);window.removeEventListener("resize",send);void api.sendOverlayMediaViewport!({session:lease.session,revision:lease.revision,tileId:tile.tileId,visible:false,width:0,height:0,fps:0}).catch(()=>{})};
 },[lease,tile.tileId,failedTrack,track]);
 return <div ref={root} data-overlay-media-kind={tile.kind} style={{minWidth:0,minHeight:0,position:"relative",background:"#0c0e14",overflow:"hidden"}}>
  {track?<video ref={video} hidden={failedTrack===track} muted autoPlay playsInline aria-label={tile.label||t(tile.kind==="camera"?"voiceOverlayVideo":"voiceOverlayStreams")} style={{width:"100%",height:"100%",objectFit:"contain"}}/>:<p role="status">{t("voiceOverlayMediaConnecting")}</p>}
  {track&&failedTrack===track&&<p role="status">{t("voiceOverlayMediaUnavailable")}</p>}
  {tile.label&&<span style={{position:"absolute",bottom:0,left:0,fontSize:11,background:"rgba(0,0,0,.8)",color:"white"}}>{tile.label}</span>}
 </div>;
}
/** HUD-only local WebRTC receiver. Never requests application/camera/audio media. */
export default function OverlayMediaPanel({video,streams,height,bottom}:{video:boolean;streams:boolean;height:number;bottom:number}){
 const {t}=useTranslation("settings"),[lease,setLease]=useState<OverlayLease|null>(null),[videos,setVideos]=useState<OverlayReceivedVideo[]>([]),[failed,setFailed]=useState(false);
 useEffect(()=>{
  const api=window.electronAPI;if(!api?.onOverlayMedia||!api.onOverlayMediaLease||!api.setOverlayMediaReceiverReady||!api.sendOverlayMedia){return;}
  let active=true,bridge:OverlayMediaBridge|null=null,owned:OverlayLease|null=null,hadVideo=false;const retired=new Set<string>();const listeners=new Set<()=>void>();
  const retire=()=>{if(owned){retired.add(`${owned.session}:${owned.revision}`);if(retired.size>16)retired.delete(retired.values().next().value!)}owned=null;hadVideo=false;bridge?.dispose();bridge=null;if(active){setLease(null);setVideos([])}};
  const offLease=api.onOverlayMediaLease(raw=>{const next=parseOverlayLease(raw);if(!active||next&&retired.has(`${next.session}:${next.revision}`))return;if(next&&owned?.session===next.session&&next.revision<=owned.revision)return;retire();if(!next||next.tiles.some(tile=>tile.kind==="camera"?!video:!streams)){setFailed(true);return;}owned=next;setLease(next);setFailed(false);
   const current=()=>active&&owned===next;bridge=createOverlayMediaReceiver({session:next.session,revision:next.revision,current,subscribeScope:fn=>{listeners.add(fn);return()=>{listeners.delete(fn)}},send:envelope=>{void api.sendOverlayMedia!(envelope).then(ok=>{if(!ok&&current()){setFailed(true);retire()}},()=>{if(current()){setFailed(true);retire()}})},onVideos:items=>{if(current()){const filtered=items.filter(item=>next.tiles.some(tile=>tile.tileId===item.tileId&&tile.kind===item.kind));if(hadVideo&&!filtered.length){retire();return;}hadVideo=filtered.length>0;setVideos(filtered)}},onError:()=>{if(current()){setFailed(true);retire()}}});
  });
  const offMedia=api.onOverlayMedia(raw=>{if(!active)return;const envelope=parseOverlayMediaEnvelope(raw);if(envelope?.kind==="end"&&envelope.session===owned?.session&&envelope.revision===owned.revision){if(envelope.reason==="error")setFailed(true);retire();return;}void bridge?.receive(raw)});
  // Broker refuses offers until BOTH local listeners have been attached.
  void api.setOverlayMediaReceiverReady(document.visibilityState==="visible").then(ok=>{if(active&&!ok)setFailed(true)},()=>{if(active)setFailed(true)});
  const reack=()=>{if(active)void api.setOverlayMediaReceiverReady!(document.visibilityState==="visible").catch(()=>{})};const visibility=()=>{if(document.visibilityState!=="visible")retire();reack()};document.addEventListener("visibilitychange",visibility);const offUpdate=api.onVoiceOverlayUpdate?.(reack);
  return()=>{active=false;owned=null;listeners.forEach(fn=>fn());bridge?.dispose();offLease();offMedia();offUpdate?.();document.removeEventListener("visibilitychange",visibility);void api.setOverlayMediaReceiverReady!(false).catch(()=>{})};
 },[video,streams]);
 const allowedLease=lease&&lease.tiles.every(tile=>tile.kind==="camera"?video:streams)?lease:null;
 return <section aria-label={t("voiceOverlayMediaTitle")} style={{position:"absolute",bottom,left:8,right:8,height:Math.min(320,height),maxHeight:320,overflow:"hidden",pointerEvents:"none",background:"rgba(12,14,20,.94)"}}>
  {allowedLease?<div style={{display:"grid",height:"100%",gridTemplateColumns:allowedLease.tiles.length>1?"1fr 1fr":"1fr",gridTemplateRows:allowedLease.tiles.length>2?"1fr 1fr":"1fr",gap:2}}>{allowedLease.tiles.map(tile=><VideoTile key={`${allowedLease.session}:${allowedLease.revision}:${tile.tileId}`} tile={tile} track={videos.find(item=>item.tileId===tile.tileId&&item.kind===tile.kind)?.track} lease={allowedLease}/>)}</div>:<p role="status">{t(failed||!window.electronAPI?.setOverlayMediaReceiverReady?"voiceOverlayMediaUnavailable":"voiceOverlayMediaEmpty")}</p>}
 </section>;
}
