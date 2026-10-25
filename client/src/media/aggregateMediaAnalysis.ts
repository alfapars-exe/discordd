import {isMediaAnalysis,sexualVerdict,type MediaAnalysis} from "./mediaClassifierContract";

/** Category-wise conservative aggregation; keep real evidence, not invented scores. */
export function aggregateMediaAnalysis(results:readonly MediaAnalysis[]):MediaAnalysis {
  if(!results.length||results.some(result=>!isMediaAnalysis(result)))throw new Error("invalid_media_batch");
  const sexualProbability=Math.max(...results.map(result=>result.sexualProbability));
  const base:MediaAnalysis={model:results[0].model,sexual:sexualVerdict(sexualProbability),sexualProbability,disturbing:"unknown"};
  const frameSampling=results.flatMap(result=>result.frameSampling?[result.frameSampling]:[]);
  if(frameSampling.length)base.frameSampling={sampledFrameCount:frameSampling.reduce((sum,item)=>sum+item.sampledFrameCount,0),totalFrameCount:frameSampling.reduce((sum,item)=>sum+item.totalFrameCount,0),attachmentCount:frameSampling.reduce((sum,item)=>sum+item.attachmentCount,0)};
  const videoSampling=results.flatMap(result=>result.videoSampling?[result.videoSampling]:[]);
  if(videoSampling.length)base.videoSampling={sampledFrameCount:videoSampling.reduce((sum,item)=>sum+item.sampledFrameCount,0),durationSeconds:videoSampling.reduce((sum,item)=>sum+item.durationSeconds,0),attachmentCount:videoSampling.reduce((sum,item)=>sum+item.attachmentCount,0)};
  const positive=results.find(result=>result.disturbing==="positive");
  const selected=positive??(results.some(result=>result.disturbing==="unknown")?undefined:results.find(result=>result.disturbing==="uncertain")??results[0]);
  if(selected?.disturbingAnalysis){base.disturbing=selected.disturbing;base.disturbingAnalysis=selected.disturbingAnalysis;}
  const incompleteSampling=frameSampling.some(item=>item.sampledFrameCount<item.totalFrameCount)||videoSampling.length>0;
  if(incompleteSampling){
    if(base.sexual==="negative")base.sexual="uncertain";
    if(base.disturbing==="negative")base.disturbing="uncertain";
  }
  return base;
}
