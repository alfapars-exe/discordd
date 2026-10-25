export async function readBoundedResponse(response:Response,maxBytes:number,signal?:AbortSignal):Promise<ArrayBuffer>{
  if(!response.ok||!response.body||!Number.isSafeInteger(maxBytes)||maxBytes<1)throw new Error("media_download_failed");
  const reader=response.body.getReader();
  const chunks:Uint8Array[]=[];
  let size=0;
  const abort=()=>{void reader.cancel().catch(()=>{});};
  signal?.addEventListener("abort",abort,{once:true});
  if(signal?.aborted)abort();
  try{
    for(;;){
      if(signal?.aborted)throw new Error("media_analysis_cancelled");
      const {done,value}=await reader.read();
      if(done)break;
      if(value.byteLength>maxBytes-size){await reader.cancel();throw new Error("media_too_large");}
      chunks.push(value);size+=value.byteLength;
    }
    if(signal?.aborted)throw new Error("media_analysis_cancelled");
    const bytes=new Uint8Array(size);let offset=0;
    for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
    return bytes.buffer;
  }finally{signal?.removeEventListener("abort",abort);reader.releaseLock();}
}
