import {aggregateMediaAnalysis} from "./aggregateMediaAnalysis";
import type {MediaAnalysis} from "./mediaClassifierContract";
import {MAX_MEDIA_PIXELS} from "./mediaInputSafety";

export const MAX_LOCAL_VIDEO_DURATION_SECONDS=120;
export const MAX_LOCAL_VIDEO_FRAMES=5;
export const LOCAL_VIDEO_ANALYSIS_TIMEOUT_MS=30_000;
export type VideoSampling={sampledFrameCount:number;durationSeconds:number;attachmentCount:number};
export type VideoSamplingPlatform={
  createVideo:()=>HTMLVideoElement;
  createObjectURL:(file:Blob)=>string;
  revokeObjectURL:(url:string)=>void;
  createImageBitmap:(video:HTMLVideoElement)=>Promise<ImageBitmap>;
  now:()=>number;
};
const browserPlatform:VideoSamplingPlatform={
  createVideo:()=>document.createElement("video"),
  createObjectURL:(file)=>URL.createObjectURL(file),
  revokeObjectURL:(url)=>URL.revokeObjectURL(url),
  createImageBitmap:(video)=>createImageBitmap(video),
  now:()=>performance.now(),
};

export function localVideoMime(mime:string):string|null{
  const normalized=mime.split(";",1)[0].trim().toLowerCase();
  return normalized==="video/mp4"||normalized==="video/webm"?normalized:null;
}

export function videoSampleTimestamps(durationSeconds:number,maxFrames=MAX_LOCAL_VIDEO_FRAMES):number[]{
  if(!Number.isFinite(durationSeconds)||durationSeconds<=0||durationSeconds>MAX_LOCAL_VIDEO_DURATION_SECONDS||!Number.isSafeInteger(maxFrames)||maxFrames<2)return [];
  const count=Math.min(MAX_LOCAL_VIDEO_FRAMES,maxFrames);
  const last=Math.max(0,durationSeconds-Math.min(0.001,durationSeconds/1000));
  return [...new Set(Array.from({length:count},(_,index)=>last*index/(count-1)))];
}

function waitFor(video:HTMLVideoElement,success:string,signal:AbortSignal,deadline:number,now:()=>number,trigger?:()=>void):Promise<void>{
  if(signal.aborted)return Promise.reject(new Error("media_analysis_cancelled"));
  return new Promise((resolve,reject)=>{
    const remaining=Math.max(0,deadline-now());
    const timeout=setTimeout(()=>finish(new Error("media_analysis_timeout")),remaining);
    const onSuccess=()=>finish();
    const onError=()=>finish(new Error("media_decode_failed"));
    const onAbort=()=>finish(new Error("media_analysis_cancelled"));
    const finish=(error?:Error)=>{
      clearTimeout(timeout);
      video.removeEventListener(success,onSuccess);
      video.removeEventListener("error",onError);
      signal.removeEventListener("abort",onAbort);
      if(error)reject(error);else resolve();
    };
    video.addEventListener(success,onSuccess,{once:true});
    video.addEventListener("error",onError,{once:true});
    signal.addEventListener("abort",onAbort,{once:true});
    try{trigger?.();}catch{finish(new Error("media_seek_failed"));}
  });
}

function bounded<T>(work:Promise<T>,signal:AbortSignal,deadline:number,now:()=>number,onLate?:(value:T)=>void):Promise<T>{
  return new Promise((resolve,reject)=>{
    let settled=false;
    const remaining=Math.max(0,deadline-now());
    const timer=setTimeout(()=>finish(new Error("media_analysis_timeout")),remaining);
    const abort=()=>finish(new Error("media_analysis_cancelled"));
    const finish=(error?:Error,value?:T)=>{
      if(settled)return;
      settled=true;clearTimeout(timer);signal.removeEventListener("abort",abort);
      if(error)reject(error);else resolve(value as T);
    };
    signal.addEventListener("abort",abort,{once:true});
    work.then(value=>{
      if(settled){try{onLate?.(value);}catch{/* Best-effort late resource cleanup. */}}
      else finish(undefined,value);
    },error=>finish(error instanceof Error?error:new Error("media_decode_failed")));
    if(signal.aborted)finish(new Error("media_analysis_cancelled"));
  });
}

/** Decode only local Blob URLs and hand each frame to the classifier before seeking again. */
export async function sampleLocalVideoFrames(
  file:Blob,
  signal:AbortSignal,
  classifyFrame:(frame:ImageBitmap,signal:AbortSignal)=>Promise<MediaAnalysis>,
  platform:VideoSamplingPlatform=browserPlatform,
  deadline=platform.now()+LOCAL_VIDEO_ANALYSIS_TIMEOUT_MS,
):Promise<{analysis:MediaAnalysis;sampling:VideoSampling}>{
  const mime=localVideoMime(file.type);
  if(!mime||file.size>12*1024*1024)throw new Error("media_unsupported");
  if(signal.aborted)throw new Error("media_analysis_cancelled");
  const video=platform.createVideo();
  const url=platform.createObjectURL(file);
  const frameAnalyses:MediaAnalysis[]=[];
  try{
    video.preload="metadata";
    video.muted=true;
    video.playsInline=true;
    if(video.canPlayType(mime)==="")throw new Error("media_decode_unavailable");
    await waitFor(video,"loadedmetadata",signal,deadline,platform.now,()=>{video.src=url;video.load();});
    const duration=video.duration,width=video.videoWidth,height=video.videoHeight;
    if(!Number.isFinite(duration)||duration<=0||duration>MAX_LOCAL_VIDEO_DURATION_SECONDS||!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1||width*height>MAX_MEDIA_PIXELS)throw new Error("media_dimensions");
    const timestamps=videoSampleTimestamps(duration);
    if(timestamps.length<2)throw new Error("media_decode_unavailable");
    for(const timestamp of timestamps){
      if(signal.aborted)throw new Error("media_analysis_cancelled");
      const changed=Math.abs(video.currentTime-timestamp)>0.00001;
      if(changed)await waitFor(video,"seeked",signal,deadline,platform.now,()=>{video.currentTime=timestamp;});
      else if(video.readyState<2)await waitFor(video,"loadeddata",signal,deadline,platform.now);
      if(video.readyState<2||video.videoWidth!==width||video.videoHeight!==height||Math.abs(video.currentTime-timestamp)>0.05)throw new Error("media_frame_incomplete");
      if(platform.now()>=deadline)throw new Error("media_analysis_timeout");
      const frame=await bounded(platform.createImageBitmap(video),signal,deadline,platform.now,(late)=>{try{late.close();}catch{/* Late decode cleanup. */}});
      if(frame.width!==width||frame.height!==height||frame.width*frame.height>MAX_MEDIA_PIXELS){frame.close();throw new Error("media_dimensions");}
      // classifyFrame consumes ownership (it either transfers and the worker closes, or closes on rejection).
      frameAnalyses.push(await bounded(classifyFrame(frame,signal),signal,deadline,platform.now));
      if(platform.now()>=deadline)throw new Error("media_analysis_timeout");
    }
    if(signal.aborted)throw new Error("media_analysis_cancelled");
    const analysis=aggregateMediaAnalysis(frameAnalyses);
    const sampling:VideoSampling={sampledFrameCount:frameAnalyses.length,durationSeconds:duration,attachmentCount:1};
    analysis.videoSampling=sampling;
    if(analysis.sexual==="negative")analysis.sexual="uncertain";
    if(analysis.disturbing==="negative")analysis.disturbing="uncertain";
    return {analysis,sampling};
  }finally{
    try{video.pause();}catch{/* Ignore cleanup failures. */}
    try{video.removeAttribute("src");video.load();}catch{/* Ignore cleanup failures. */}
    try{platform.revokeObjectURL(url);}catch{/* Ignore cleanup failures. */}
  }
}

/** One timeout covers metadata, seeks, and every model inference for this video. */
export async function analyzeLocalVideo(
  file:Blob,
  signal:AbortSignal,
  classifyFrame:(frame:ImageBitmap,signal:AbortSignal)=>Promise<MediaAnalysis>,
  platform:VideoSamplingPlatform=browserPlatform,
):Promise<MediaAnalysis>{
  const controller=new AbortController();
  let timeout=false;
  const abort=()=>controller.abort();
  if(signal.aborted)controller.abort();else signal.addEventListener("abort",abort,{once:true});
  const timer=setTimeout(()=>{timeout=true;controller.abort();},LOCAL_VIDEO_ANALYSIS_TIMEOUT_MS);
  try{return (await sampleLocalVideoFrames(file,controller.signal,classifyFrame,platform,platform.now()+LOCAL_VIDEO_ANALYSIS_TIMEOUT_MS)).analysis;}
  catch(error){if(timeout)throw new Error("media_analysis_timeout",{cause:error});throw error;}
  finally{clearTimeout(timer);signal.removeEventListener("abort",abort);}
}
