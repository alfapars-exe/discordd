/** Static model assets have exact pinned sizes; never buffer an unbounded body. */
export async function readExactMediaAsset(response:Response,expectedBytes:number):Promise<ArrayBuffer> {
  if(!response.ok||!response.body||!Number.isSafeInteger(expectedBytes)||expectedBytes<1)throw new Error("media_model_unavailable");
  const reader=response.body.getReader();
  const result=new Uint8Array(expectedBytes);
  let used=0;
  try{
    for(;;){
      const {done,value}=await reader.read();
      if(done)break;
      if(value.byteLength>expectedBytes-used){await reader.cancel();throw new Error("media_model_integrity");}
      result.set(value,used);used+=value.byteLength;
    }
    if(used!==expectedBytes)throw new Error("media_model_integrity");
    return result.buffer;
  }finally{reader.releaseLock();}
}
