import {DISTURBING_MODEL,interpretDisturbingProbabilities,type DisturbingAnalysis} from "./disturbingModelContract";
export const MEDIA_MODEL = {
  id: "nsfwjs-mobilenet-v2-d55a54c",
  manifest: {bytes:128945,sha256:"11846416217e68bf1eb7b0e651bcfd305973566453c63275bbd16766ab089979"},
  weights: {bytes:2619461,sha256:"8e7dddbb16acacc1bf1601b1b8a761e730ff934b7f2d7771312b2f000e5f5f13"},
} as const;
export type FrameSampling={sampledFrameCount:number;totalFrameCount:number;attachmentCount:number};
export type VideoSampling={sampledFrameCount:number;durationSeconds:number;attachmentCount:number};
export type MediaAnalysis = {model:typeof MEDIA_MODEL.id;sexual:"positive"|"negative"|"uncertain";disturbing:"unknown"|DisturbingAnalysis["verdict"];sexualProbability:number;disturbingAnalysis?:DisturbingAnalysis;frameSampling?:FrameSampling;videoSampling?:VideoSampling};
export function sexualVerdict(probability:number):MediaAnalysis["sexual"]{return probability>=0.7?"positive":probability<=0.1?"negative":"uncertain";}
export function isMediaAnalysis(input:unknown):input is MediaAnalysis {
  if(!input||typeof input!=="object")return false;
  const value=input as Partial<MediaAnalysis>;
  if(!(value.model===MEDIA_MODEL.id&&typeof value.sexualProbability==="number"&&Number.isFinite(value.sexualProbability)&&value.sexualProbability>=0&&value.sexualProbability<=1.001))return false;
  const sampling=value.frameSampling;
  if(sampling!==undefined&&(!sampling||!Number.isSafeInteger(sampling.attachmentCount)||sampling.attachmentCount<1||sampling.attachmentCount>4||!Number.isSafeInteger(sampling.sampledFrameCount)||sampling.sampledFrameCount<2*sampling.attachmentCount||sampling.sampledFrameCount>5*sampling.attachmentCount||!Number.isSafeInteger(sampling.totalFrameCount)||sampling.totalFrameCount<sampling.sampledFrameCount||sampling.totalFrameCount>100_000*sampling.attachmentCount))return false;
  const videoSampling=value.videoSampling;
  if(videoSampling!==undefined&&(!videoSampling||!Number.isSafeInteger(videoSampling.attachmentCount)||videoSampling.attachmentCount<1||videoSampling.attachmentCount>4||!Number.isSafeInteger(videoSampling.sampledFrameCount)||videoSampling.sampledFrameCount<2*videoSampling.attachmentCount||videoSampling.sampledFrameCount>5*videoSampling.attachmentCount||typeof videoSampling.durationSeconds!=="number"||!Number.isFinite(videoSampling.durationSeconds)||videoSampling.durationSeconds<=0||videoSampling.durationSeconds>120*videoSampling.attachmentCount))return false;
  if((sampling?.attachmentCount??0)+(videoSampling?.attachmentCount??0)>4)return false;
  const incompleteSampling=(!!sampling&&sampling.sampledFrameCount<sampling.totalFrameCount)||!!videoSampling;
  if(value.sexual!==sexualVerdict(value.sexualProbability)&&!(incompleteSampling&&value.sexual==="uncertain"&&sexualVerdict(value.sexualProbability)==="negative"))return false;
  if(value.disturbing==="unknown")return value.disturbingAnalysis===undefined;
  const detail=value.disturbingAnalysis;
  if(!detail||detail.model!==DISTURBING_MODEL.id||typeof detail.probability!=="number"||typeof detail.safeProbability!=="number"||typeof detail.sexualClassProbability!=="number")return false;
  try {
    const checked=interpretDisturbingProbabilities([detail.probability,detail.sexualClassProbability,detail.safeProbability]);
    return checked.verdict===detail.verdict&&(value.disturbing===detail.verdict||(incompleteSampling&&value.disturbing==="uncertain"&&detail.verdict==="negative"));
  } catch {return false;}
}
