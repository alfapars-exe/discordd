/// <reference lib="webworker" />
import {loadMediaModel,predictMediaPixels,MEDIA_MODEL,type MediaAnalysis} from "./mediaClassifierModel";
import {inspectAnimatedRaster,isSupportedStaticImage,MAX_MEDIA_PIXELS,sampleFrameIndexes} from "./mediaInputSafety";
import {readExactMediaAsset} from "./mediaModelAssets";
import {loadDisturbingModel} from "./disturbingModelRuntime";

type Job={id:number;file?:Blob;bitmap?:ImageBitmap;modelBase:string};
let model:ReturnType<typeof loadMediaModel>|undefined;
let disturbingModel:ReturnType<typeof loadDisturbingModel>|undefined;
let busy=false;

async function fetchModel(base:string) {
  const root=new URL(base);
  if(root.origin!==self.location.origin||!root.pathname.endsWith("/media-classifier/v1/"))throw new Error("media_model_origin");
  const responses=await Promise.all(["model.json","group1-shard1of1"].map((name)=>fetch(new URL(name,root),{credentials:"omit",redirect:"error",signal:AbortSignal.timeout(15000)})));
  if(responses.some((response)=>!response.ok))throw new Error("media_model_unavailable");
  return loadMediaModel(await readExactMediaAsset(responses[0],MEDIA_MODEL.manifest.bytes),await readExactMediaAsset(responses[1],MEDIA_MODEL.weights.bytes));
}

async function classifyPixels(rgb:Uint8Array,width:number,height:number,modelBase:string):Promise<MediaAnalysis>{
  model??=fetchModel(modelBase).catch((error)=>{model=undefined;throw error;});
  const analysis:MediaAnalysis=await predictMediaPixels(await model,rgb,width,height);
  try {
    const root=new URL(modelBase);
    if(root.origin!==self.location.origin||!root.pathname.endsWith("/media-classifier/v1/")||root.search||root.hash)throw new Error("media_model_origin");
    disturbingModel??=loadDisturbingModel(new URL("../v2/",root).href).catch(error=>{disturbingModel=undefined;throw error;});
    const detail=await (await disturbingModel).predict(rgb,width,height);
    analysis.disturbing=detail.verdict;
    analysis.disturbingAnalysis=detail;
  } catch {
    // Independent failure is unknown, never a safe result or sexual fallback.
    analysis.disturbing="unknown";
    delete analysis.disturbingAnalysis;
  }
  return analysis;
}

async function pixelsFromBitmap(bitmap:ImageBitmap):Promise<Uint8Array>{
  if(bitmap.width<1||bitmap.height<1||bitmap.width*bitmap.height>MAX_MEDIA_PIXELS)throw new Error("media_dimensions");
  const canvas=new OffscreenCanvas(bitmap.width,bitmap.height);
  const context=canvas.getContext("2d",{willReadFrequently:true});
  if(!context)throw new Error("media_decode_unavailable");
  context.drawImage(bitmap,0,0);
  const pixels=context.getImageData(0,0,bitmap.width,bitmap.height).data;
  const rgb=new Uint8Array(bitmap.width*bitmap.height*3);
  for(let from=0,to=0;from<pixels.length;from+=4){rgb[to++]=pixels[from];rgb[to++]=pixels[from+1];rgb[to++]=pixels[from+2];}
  return rgb;
}

async function classifyStatic(file:Blob,bytes:Uint8Array,modelBase:string):Promise<MediaAnalysis>{
  if(!isSupportedStaticImage(bytes,file.type))throw new Error("media_unsupported");
  const bitmap=await createImageBitmap(file);
  try{return await classifyPixels(await pixelsFromBitmap(bitmap),bitmap.width,bitmap.height,modelBase);}
  finally{bitmap.close();}
}

async function classifyAnimated(file:Blob,bytes:Uint8Array,modelBase:string):Promise<MediaAnalysis>{
  const info=inspectAnimatedRaster(bytes,file.type);
  if(!info)throw new Error("media_unsupported");
  if(typeof ImageDecoder==="undefined"||!await ImageDecoder.isTypeSupported(file.type))throw new Error("media_decode_unavailable");
  const decoder=new ImageDecoder({data:bytes,type:file.type,preferAnimation:true});
  try{
    await decoder.tracks.ready;
    await decoder.completed;
    const track=decoder.tracks.selectedTrack;
    if(!decoder.complete||!track||!track.animated||track.frameCount!==info.frameCount||track.frameCount<2)throw new Error("media_incomplete");
    const indexes=sampleFrameIndexes(track.frameCount);
    if(indexes.length<2)throw new Error("media_incomplete");
    const analyses:MediaAnalysis[]=[];
    for(const frameIndex of indexes){
      const result=await decoder.decode({frameIndex,completeFramesOnly:true});
      const frame=result.image;
      try{
        if(!result.complete||frame.displayWidth!==info.width||frame.displayHeight!==info.height||frame.displayWidth*frame.displayHeight>MAX_MEDIA_PIXELS)throw new Error("media_incomplete");
        const canvas=new OffscreenCanvas(frame.displayWidth,frame.displayHeight);
        const context=canvas.getContext("2d",{willReadFrequently:true});
        if(!context)throw new Error("media_decode_unavailable");
        context.drawImage(frame,0,0);
        const rgba=context.getImageData(0,0,frame.displayWidth,frame.displayHeight).data;
        const rgb=new Uint8Array(frame.displayWidth*frame.displayHeight*3);
        for(let from=0,to=0;from<rgba.length;from+=4){rgb[to++]=rgba[from];rgb[to++]=rgba[from+1];rgb[to++]=rgba[from+2];}
        analyses.push(await classifyPixels(rgb,frame.displayWidth,frame.displayHeight,modelBase));
      }finally{frame.close();}
    }
    const sexualProbability=Math.max(...analyses.map(value=>value.sexualProbability));
    const positive=analyses.find(value=>value.disturbing==="positive");
    const uncertain=analyses.find(value=>value.disturbing==="uncertain");
    const unknown=analyses.some(value=>value.disturbing==="unknown");
    const incompleteSampling=indexes.length<track.frameCount;
    const selected=positive??uncertain??(unknown?undefined:analyses[0]);
    const sexual=sexualProbability>=0.7?"positive":sexualProbability<=0.1?(incompleteSampling?"uncertain":"negative"):"uncertain";
    const disturbing=positive?"positive":unknown?"unknown":uncertain||incompleteSampling?"uncertain":selected?.disturbing??"unknown";
    const analysis:MediaAnalysis={
      model:analyses[0].model,
      sexual,
      sexualProbability,
      disturbing,
      frameSampling:{sampledFrameCount:indexes.length,totalFrameCount:track.frameCount,attachmentCount:1},
    };
    if(selected?.disturbingAnalysis)analysis.disturbingAnalysis=selected.disturbingAnalysis;
    return analysis;
  }finally{decoder.close();}
}

self.onmessage=async (event:MessageEvent<Job>)=>{
  const {id,file,bitmap,modelBase}=event.data;
  const closeTransferredBitmap=()=>{try{bitmap?.close();}catch{/* Ignore invalid transferred-frame cleanup. */}};
  if(busy){closeTransferredBitmap();self.postMessage({id,error:"media_classifier_busy"});return;}
  const hasFile=file instanceof Blob&&file.size<=12*1024*1024&&/^image\/(png|jpeg|webp|bmp|gif)$/.test(file.type);
  const hasBitmap=!!bitmap&&typeof bitmap.close==="function";
  if(!Number.isSafeInteger(id)||hasFile===hasBitmap) {closeTransferredBitmap();self.postMessage({id,error:"media_unsupported"});return;}
  busy=true;
  try{
    const analysis=hasBitmap
      ? await classifyBitmap(bitmap!,modelBase)
      : await classifyFile(file!,modelBase);
    self.postMessage({id,analysis});
  }catch{
    // Never serialize image content, filenames, model internals or exception text.
    self.postMessage({id,error:"media_analysis_failed"});
  }finally{closeTransferredBitmap();busy=false;}
};

async function classifyBitmap(bitmap:ImageBitmap,modelBase:string):Promise<MediaAnalysis>{
  if(bitmap.width<1||bitmap.height<1||bitmap.width*bitmap.height>MAX_MEDIA_PIXELS)throw new Error("media_dimensions");
  return classifyPixels(await pixelsFromBitmap(bitmap),bitmap.width,bitmap.height,modelBase);
}

async function classifyFile(file:Blob,modelBase:string):Promise<MediaAnalysis>{
  const bytes=new Uint8Array(await file.arrayBuffer());
  return isSupportedStaticImage(bytes,file.type)
    ? await classifyStatic(file,bytes,modelBase)
    : await classifyAnimated(file,bytes,modelBase);
}
