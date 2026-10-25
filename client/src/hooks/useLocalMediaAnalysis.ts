import {useEffect,useState} from "react";
import {decryptFile,type EncryptedFileMeta} from "../crypto/fileEncryption";
import {analyzeMediaLocally} from "../media/mediaClassifierClient";
import type {MediaAnalysis} from "../media/mediaClassifierContract";
import {aggregateMediaAnalysis} from "../media/aggregateMediaAnalysis";
import {getAuthGeneration} from "../api/client";
import {useAuthStore} from "../stores/authStore";
import {useE2EEStore} from "../stores/e2eeStore";
import {resolveAssetUrl,SERVER_URL} from "../utils/constants";
import {readBoundedResponse} from "../utils/readBoundedResponse";
import {acquireMediaAnalysisSlot} from "../media/mediaAnalysisSlots";
import {localVideoMime} from "../media/localVideoSampling";

export type LocalMediaInput={url:string;mimeType:string;size?:number|null;fileMeta?:EncryptedFileMeta};
const limit=12*1024*1024;
export function useLocalMediaAnalysis(inputs:readonly LocalMediaInput[],enabled:boolean,onSettled:()=>void){
  const owner=useAuthStore((state)=>state.user?.id);
  const device=useE2EEStore((state)=>state.localDeviceId);
  const generation=useAuthStore(()=>getAuthGeneration());
  const serialized=JSON.stringify(inputs);
  const key=JSON.stringify([owner,device,generation,serialized,enabled]);
  const [state,setState]=useState<{key:string;status:"ready"|"error";analysis?:MediaAnalysis}>();
  const [retry,setRetry]=useState(0);
  useEffect(()=>{
    if(!enabled||!owner||serialized==="[]")return;
    let active=true;
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),45000);
    const alive=()=>active&&useAuthStore.getState().user?.id===owner&&getAuthGeneration()===generation&&useE2EEStore.getState().localDeviceId===device;
    const current=()=>alive()&&!controller.signal.aborted;
    void(async()=>{
      let release:(()=>void)|undefined;
      try{
        const sources=JSON.parse(serialized) as LocalMediaInput[];
        if(sources.length>4)throw new Error("media_analysis_limit");
        release=await acquireMediaAnalysisSlot(controller.signal);
        const results:MediaAnalysis[]=[];
        for(const source of sources){
          if(!current())throw new Error("media_analysis_cancelled");
          const mime=source.fileMeta?.mimeType??source.mimeType;
          if(source.fileMeta&&!device)throw new Error("media_device_unavailable");
          if(!(/^image\/(png|jpeg|webp|bmp|gif)$/.test(mime)||localVideoMime(mime))||Number(source.size??0)>limit+(source.fileMeta?16:0)||Number(source.fileMeta?.originalSize??0)>limit)throw new Error("media_unsupported");
          const url=new URL(resolveAssetUrl(source.url),window.location.href);
          const origin=new URL(SERVER_URL||window.location.origin).origin;
          // Never contact third-party preview URLs or sender-controlled origins.
          if(url.origin!==origin||!/^https?:$/.test(url.protocol)||url.username||url.password||!/^\/(api\/)?uploads\//.test(url.pathname))throw new Error("media_origin");
          let file:Blob;
          if(source.fileMeta)file=await decryptFile(url.href,source.fileMeta,{signal:controller.signal,maxBytes:limit+16});
          else{
            const response=await fetch(url.href,{credentials:"include",redirect:"error",signal:controller.signal});
            file=new Blob([await readBoundedResponse(response,limit,controller.signal)],{type:mime});
          }
          if(!current())throw new Error("media_analysis_cancelled");
          results.push(await analyzeMediaLocally(file,controller.signal));
        }
        if(!current())return;
        const analysis=aggregateMediaAnalysis(results);
        onSettled();setState({key,status:"ready",analysis});
      }catch{if(alive()){onSettled();setState({key,status:"error"});}}
      finally{release?.();clearTimeout(timer);}
    })();
    return()=>{active=false;clearTimeout(timer);controller.abort();};
  // Serialized descriptors capture URL/key/revision changes without depending on
  // newly allocated parent arrays. They are memory-only, never persisted/logged.
  },[enabled,owner,device,generation,serialized,key,retry,onSettled]);
  const status=!enabled||!owner||!inputs.length?"idle":state?.key===key?state.status:"loading";
  return {status,analysis:status==="ready"?state?.analysis:undefined,retry:()=>{setState(undefined);setRetry((value)=>value+1);}};
}
