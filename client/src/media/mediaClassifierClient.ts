import {isMediaAnalysis,type MediaAnalysis} from "./mediaClassifierContract";
import {isNativeApp} from "../utils/constants";
import {analyzeLocalVideo,localVideoMime} from "./localVideoSampling";

type Port={onmessage:((event:MessageEvent)=>void)|null;onerror:((event:ErrorEvent)=>unknown)|null;postMessage:(data:unknown,transfer:Transferable[])=>void;terminate:()=>void};
type Job={id:number;input:{file:Blob}|{bitmap:ImageBitmap};signal?:AbortSignal;resolve:(value:MediaAnalysis)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>;abort:()=>void;transferred:boolean};
export class MediaClassifierClient {
  private worker:Port|undefined;
  private active:Job|undefined;
  private queue:Job[]=[];
  private sequence=0;
  private idle:ReturnType<typeof setTimeout>|undefined;
  private readonly factory:()=>Port;
  private readonly modelBase:string;
  constructor(factory:()=>Port,modelBase:string){this.factory=factory;this.modelBase=modelBase;}
  analyze(file:Blob,signal?:AbortSignal):Promise<MediaAnalysis>{
    return this.enqueue({file},signal);
  }
  analyzeBitmap(bitmap:ImageBitmap,signal?:AbortSignal):Promise<MediaAnalysis>{
    if(bitmap.width<1||bitmap.height<1||bitmap.width*bitmap.height>4_000_000){bitmap.close();return Promise.reject(new Error("media_unsupported"));}
    return this.enqueue({bitmap},signal);
  }
  analyzeVideo(file:Blob,signal?:AbortSignal):Promise<MediaAnalysis>{
    return analyzeLocalVideo(file,signal??new AbortController().signal,(bitmap,innerSignal)=>this.analyzeBitmap(bitmap,innerSignal));
  }
  private enqueue(input:Job["input"],signal?:AbortSignal):Promise<MediaAnalysis>{
    if(signal?.aborted){if("bitmap" in input)input.bitmap.close();return Promise.reject(new Error("media_analysis_cancelled"));}
    const file="file" in input?input.file:undefined;
    if(file&&(file.size>12*1024*1024||!/^image\/(png|jpeg|webp|bmp|gif)$/.test(file.type)))return Promise.reject(new Error("media_unsupported"));
    if(this.queue.length+(this.active?1:0)>=4){if("bitmap" in input)input.bitmap.close();return Promise.reject(new Error("media_classifier_busy"));}
    return new Promise((resolve,reject)=>{
      const job:Job={id:++this.sequence,input,signal,resolve,reject,transferred:false,timer:setTimeout(()=>this.cancel(job,"media_analysis_timeout"),30000),abort:()=>this.cancel(job,"media_analysis_cancelled")};
      signal?.addEventListener("abort",job.abort,{once:true});
      this.queue.push(job);this.pump();
    });
  }
  dispose(){
    this.stopWorker();
    const jobs=[...(this.active?[this.active]:[]),...this.queue];
    this.active=undefined;this.queue=[];
    for(const job of jobs){this.clean(job);job.reject(new Error("media_analysis_cancelled"));}
  }
  private clean(job:Job){clearTimeout(job.timer);job.signal?.removeEventListener("abort",job.abort);if("bitmap" in job.input&&!job.transferred)job.input.bitmap.close();}
  private stopWorker(){clearTimeout(this.idle);this.worker?.terminate();this.worker=undefined;}
  private cancel(job:Job,reason:string){
    if(this.active===job){this.finish(undefined,new Error(reason),true);return;}
    const index=this.queue.indexOf(job);
    if(index<0)return;
    this.queue.splice(index,1);this.clean(job);job.reject(new Error(reason));
  }
  private finish(result?:MediaAnalysis,error?:Error,stop=false){
    const job=this.active;if(!job)return;
    this.active=undefined;this.clean(job);
    if(stop)this.stopWorker();
    if(result)job.resolve(result);else job.reject(error??new Error("media_analysis_failed"));
    this.pump();
  }
  private pump(){
    if(this.active)return;
    clearTimeout(this.idle);
    const job=this.queue.shift();
    if(!job){this.idle=setTimeout(()=>this.stopWorker(),10000);return;}
    this.active=job;
    try{
      if(!this.worker){
      const worker=this.factory();this.worker=worker;
        worker.onmessage=(event)=>{
          if(this.worker!==worker)return;
          const value=event.data as {id?:number;analysis?:unknown};
          if(!value||value.id!==this.active?.id)return;
          const job=this.active;
          const analysis=value.analysis;
          const validAnalysis=isMediaAnalysis(analysis);
          const workerMetadataAllowed=validAnalysis&&!!job&&("bitmap" in job.input
            ? !analysis.frameSampling&&!analysis.videoSampling
            : !analysis.videoSampling&&(!analysis.frameSampling||analysis.frameSampling.attachmentCount===1));
          if(validAnalysis&&workerMetadataAllowed)this.finish(analysis);
          else this.finish(undefined,new Error("media_analysis_failed"),true);
        };
        worker.onerror=()=>{if(this.worker===worker)this.finish(undefined,new Error("media_analysis_failed"),true);};
      }
      if("bitmap" in job.input){this.worker.postMessage({id:job.id,bitmap:job.input.bitmap,modelBase:this.modelBase},[job.input.bitmap]);job.transferred=true;}
      else this.worker.postMessage({id:job.id,file:job.input.file,modelBase:this.modelBase},[]);
    }catch{this.finish(undefined,new Error("media_analysis_failed"),true);}
  }
}

let shared:MediaClassifierClient|undefined;
export function analyzeMediaLocally(file:Blob,signal:AbortSignal){
  shared??=new MediaClassifierClient(()=>new Worker(new URL("./mediaClassifier.worker.ts",import.meta.url),{type:"module"}),new URL(`${isNativeApp()?import.meta.env.BASE_URL:"/"}media-classifier/v1/`,document.baseURI).href);
  if(localVideoMime(file.type))return shared.analyzeVideo(file,signal);
  return shared.analyze(file,signal);
}
