import {afterEach,expect,it,vi} from "vitest";
import {analyzeLocalVideo,localVideoMime,sampleLocalVideoFrames,type VideoSamplingPlatform} from "./localVideoSampling";
import {MEDIA_MODEL,type MediaAnalysis} from "./mediaClassifierContract";
import {interpretDisturbingProbabilities} from "./disturbingModelContract";

class FakeVideo extends EventTarget {
  preload="";
  muted=false;
  playsInline=false;
  src="";
  loadedSources:string[]=[];
  duration=30;
  videoWidth=640;
  videoHeight=360;
  readyState=0;
  private time=0;
  get currentTime(){return this.time;}
  set currentTime(value:number){this.time=value;this.readyState=2;queueMicrotask(()=>this.dispatchEvent(new Event("seeked")));}
  canPlayType=vi.fn(()=>"probably");
  pause=vi.fn();
  load=vi.fn(()=>{
    if(this.src){
      this.loadedSources.push(this.src);
      this.readyState=2;
      queueMicrotask(()=>{this.dispatchEvent(new Event("loadedmetadata"));this.dispatchEvent(new Event("loadeddata"));});
    }
  });
  removeAttribute=vi.fn((name:string)=>{if(name==="src")this.src="";});
}

function setup(){
  const video=new FakeVideo();
  let now=0;
  const revoked:string[]=[];
  const bitmaps:{width:number;height:number;close:ReturnType<typeof vi.fn>}[]=[];
  const platform:VideoSamplingPlatform={
    createVideo:()=>video as unknown as HTMLVideoElement,
    createObjectURL:vi.fn(()=>"blob:local-video"),
    revokeObjectURL:(url)=>revoked.push(url),
    createImageBitmap:vi.fn(async()=>{const bitmap={width:640,height:360,close:vi.fn()};bitmaps.push(bitmap);return bitmap as unknown as ImageBitmap;}),
    now:()=>now,
  };
  return {video,platform,revoked,bitmaps,advance:(ms:number)=>{now+=ms;}};
}
const safe:MediaAnalysis={model:MEDIA_MODEL.id,sexual:"negative",sexualProbability:0.02,disturbing:"negative",disturbingAnalysis:interpretDisturbingProbabilities([0.01,0.01,0.98])};
const videoFile=()=>new Blob([new Uint8Array([0,0,0,24])],{type:"video/mp4"});
afterEach(()=>vi.useRealTimers());

it("accepts only bounded MP4/WebM MIME and samples local video at no more than five timestamps",async()=>{
  expect(localVideoMime(" Video/WEBM; codecs=vp9 ")).toBe("video/webm");
  expect(localVideoMime("video/quicktime")).toBeNull();
  const state=setup();
  const seen:number[]=[];
  const result=await sampleLocalVideoFrames(videoFile(),new AbortController().signal,async(frame)=>{
    seen.push(state.video.currentTime);
    frame.close();
    return safe;
  },state.platform);
  expect(seen).toHaveLength(5);
  expect(new Set(seen).size).toBe(5);
  expect(seen[0]).toBe(0);
  expect(seen[4]).toBeLessThan(30);
  expect(state.platform.createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
  expect(state.video.loadedSources).toEqual(["blob:local-video"]);
  expect(state.revoked).toEqual(["blob:local-video"]);
  expect(state.video.pause).toHaveBeenCalledOnce();
  expect(state.video.removeAttribute).toHaveBeenCalledWith("src");
  expect(result.sampling).toEqual({sampledFrameCount:5,durationSeconds:30,attachmentCount:1});
  expect(result.analysis.videoSampling).toEqual(result.sampling);
  expect(result.analysis.sexual).toBe("uncertain");
  expect(result.analysis.disturbing).toBe("uncertain");
  expect(state.bitmaps.every((bitmap)=>bitmap.close.mock.calls.length===1)).toBe(true);
});

it("preserves positive evidence across the sampled video even though negatives are partial",async()=>{
  const state=setup();
  const positive={...safe,sexual:"positive" as const,sexualProbability:0.92,disturbing:"positive" as const,disturbingAnalysis:interpretDisturbingProbabilities([0.8,0.1,0.1])};
  let index=0;
  const result=await sampleLocalVideoFrames(videoFile(),new AbortController().signal,async(frame)=>{frame.close();return index++===2?positive:safe;},state.platform);
  expect(result.analysis.sexual).toBe("positive");
  expect(result.analysis.disturbing).toBe("positive");
});

it("fails closed for unsupported duration and dimensions and still releases the local URL",async()=>{
  for(const mutate of [(video:FakeVideo)=>{video.duration=121;},(video:FakeVideo)=>{video.videoWidth=3000;video.videoHeight=2000;}]){
    const state=setup();mutate(state.video);
    await expect(sampleLocalVideoFrames(videoFile(),new AbortController().signal,async(frame)=>{frame.close();return safe;},state.platform)).rejects.toThrow("media_dimensions");
    expect(state.revoked).toEqual(["blob:local-video"]);
  }
});

it("aborts during sampling and closes the outstanding bitmap and video resources",async()=>{
  const state=setup();
  const controller=new AbortController();
  await expect(sampleLocalVideoFrames(videoFile(),controller.signal,async(frame)=>{state.bitmaps.push(frame as unknown as typeof state.bitmaps[number]);controller.abort();frame.close();throw new Error("media_analysis_cancelled");},state.platform)).rejects.toThrow("media_analysis_cancelled");
  expect(state.revoked).toEqual(["blob:local-video"]);
  expect(state.video.pause).toHaveBeenCalledOnce();
});

it("applies one shared 30-second budget to metadata, frame seeks, and inference",async()=>{
  const state=setup();
  await expect(sampleLocalVideoFrames(videoFile(),new AbortController().signal,async(frame)=>{frame.close();state.advance(31_000);return safe;},state.platform,30_000)).rejects.toThrow("media_analysis_timeout");
  expect(state.revoked).toEqual(["blob:local-video"]);
});

it("honors caller abort even when it happens before analysis starts",async()=>{
  const state=setup();
  const controller=new AbortController();controller.abort();
  await expect(analyzeLocalVideo(videoFile(),controller.signal,async(frame)=>{frame.close();return safe;},state.platform)).rejects.toThrow("media_analysis_cancelled");
  expect(state.platform.createObjectURL).not.toHaveBeenCalled();
});

it("bounds a stalled frame decode and closes a bitmap that arrives after cancellation",async()=>{
  vi.useFakeTimers();
  const state=setup();
  let finishDecode:((bitmap:ImageBitmap)=>void)|undefined;
  state.platform.createImageBitmap=()=>new Promise(resolve=>{finishDecode=resolve;});
  const pending=sampleLocalVideoFrames(videoFile(),new AbortController().signal,async(frame)=>{frame.close();return safe;},state.platform,30);
  const rejected=expect(pending).rejects.toThrow("media_analysis_timeout");
  await Promise.resolve();await Promise.resolve();
  await vi.advanceTimersByTimeAsync(31);
  await rejected;
  const late={width:640,height:360,close:vi.fn()} as unknown as ImageBitmap;
  finishDecode?.(late);
  await Promise.resolve();
  expect(late.close).toHaveBeenCalledOnce();
  expect(state.revoked).toEqual(["blob:local-video"]);
});

it("bounds a stalled classifier call and releases the decoded frame/video",async()=>{
  vi.useFakeTimers();
  const state=setup();
  const frame={width:640,height:360,close:vi.fn()} as unknown as ImageBitmap;
  state.platform.createImageBitmap=vi.fn(async()=>frame);
  const pending=sampleLocalVideoFrames(videoFile(),new AbortController().signal,()=>new Promise<MediaAnalysis>(()=>{}),state.platform,30);
  const rejected=expect(pending).rejects.toThrow("media_analysis_timeout");
  await Promise.resolve();await Promise.resolve();await Promise.resolve();
  await vi.advanceTimersByTimeAsync(31);
  await rejected;
  expect(state.revoked).toEqual(["blob:local-video"]);
});
