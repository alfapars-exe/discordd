import{useCallback,useRef,useSyncExternalStore}from "react";
import{VideoTrack,type TrackReference}from "@livekit/components-react";
import{TrackEvent}from "livekit-client";
import{useVideoViewport}from "./useVideoViewport";
/** Publisher mute removes the actual video element, so camera OFF cannot retain
 * a last decoded frame. A transient raw mute keeps the actual video box mounted
 * but transparent, preserving geometry and demand until receiver frames return. */
export default function AuthorizedVideoTrack({trackRef,...props}:React.ComponentProps<typeof VideoTrack>&{trackRef:TrackReference}){const ref=useRef<HTMLDivElement>(null),publication=trackRef.publication,track=publication.track,raw=track?.mediaStreamTrack;
 const subscribe=useCallback((changed:()=>void)=>{publication.on(TrackEvent.Muted,changed);publication.on(TrackEvent.Unmuted,changed);raw?.addEventListener("mute",changed);raw?.addEventListener("unmute",changed);return()=>{publication.off(TrackEvent.Muted,changed);publication.off(TrackEvent.Unmuted,changed);raw?.removeEventListener("mute",changed);raw?.removeEventListener("unmute",changed)}},[publication,raw]);
 const muted=useSyncExternalStore(subscribe,()=>(publication.isMuted||track?.isMuted?1:0)+(raw?.muted?2:0),()=>1);
 useVideoViewport(publication,ref);return <div ref={ref} aria-busy={!(muted&1)&&!!(muted&2)} style={{width:"100%",height:"100%",minHeight:0}}>{!(muted&1)&&<VideoTrack {...props} style={muted&2?{...props.style,opacity:0}:props.style} trackRef={trackRef}/>}</div>}
