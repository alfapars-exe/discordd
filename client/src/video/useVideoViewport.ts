import {useLayoutEffect,type RefObject}from "react";
import {authorizedVideoSources,getPublicationVideoSource}from "./authorizedVideoSources";
import type{VideoViewportLease}from "./videoVisibilityCoordinator";
/** Actual element geometry/intersection and document visibility; never fake PiP. */
export function useVideoViewport(publication:object|undefined,element:RefObject<HTMLElement|null>){useLayoutEffect(()=>{const target=element.current;if(!publication||!target)return;let active=true;let lease:VideoViewportLease|null=null,source:ReturnType<typeof getPublicationVideoSource>,intersecting=typeof IntersectionObserver==="undefined";
 const update=()=>{if(!active)return;const next=getPublicationVideoSource(publication);if(next!==source){lease?.release();lease=null;source=next}const rect=target.getBoundingClientRect(),ratio=window.devicePixelRatio||1;
 const viewport={surface:"main"as const,visible:document.visibilityState!=="hidden"&&intersecting&&rect.width>0&&rect.height>0,width:rect.width*ratio,height:rect.height*ratio,fps:120};
 if(!lease)lease=source?.addViewport(viewport)??null;else lease.update(viewport);
 };
 const resize=typeof ResizeObserver!=="undefined"?new ResizeObserver(update):null;resize?.observe(target);
 const intersection=typeof IntersectionObserver!=="undefined"?new IntersectionObserver(entries=>{intersecting=entries.some(entry=>entry.target===target&&entry.isIntersecting);update()}):null;intersection?.observe(target);
 const off=authorizedVideoSources.subscribe(update);document.addEventListener("visibilitychange",update);window.addEventListener("resize",update);update();
 return()=>{active=false;off();resize?.disconnect();intersection?.disconnect();document.removeEventListener("visibilitychange",update);window.removeEventListener("resize",update);lease?.release()};
 },[publication,element]);}
