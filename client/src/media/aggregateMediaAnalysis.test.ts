import {expect,it} from "vitest";
import {aggregateMediaAnalysis} from "./aggregateMediaAnalysis";
import {MEDIA_MODEL,isMediaAnalysis,type MediaAnalysis} from "./mediaClassifierContract";
import {interpretDisturbingProbabilities} from "./disturbingModelContract";
const unknown:MediaAnalysis={model:MEDIA_MODEL.id,sexual:"negative",sexualProbability:0.01,disturbing:"unknown"};
function result(scores:number[]):MediaAnalysis{const detail=interpretDisturbingProbabilities(scores);return {...unknown,disturbing:detail.verdict,disturbingAnalysis:detail};}
const negative=result([0.01,0.01,0.98]),positive=result([0.8,0.1,0.1]),uncertain=result([0.1,0.8,0.1]);
it("requires all negative and preserves positive evidence regardless of order",()=>{
  for(const values of [[negative,positive],[positive,unknown],[unknown,positive]])expect(aggregateMediaAnalysis(values).disturbing).toBe("positive");
  expect(aggregateMediaAnalysis([negative,negative]).disturbing).toBe("negative");
  for(const values of [[negative,unknown],[uncertain,unknown]]){
    const combined=aggregateMediaAnalysis(values);
    expect(combined.disturbing).toBe("unknown");expect(combined).not.toHaveProperty("disturbingAnalysis");
  }
  expect(aggregateMediaAnalysis([negative,uncertain]).disturbing).toBe("uncertain");
});
it("aggregates sexual scores independently and produces a valid contract",()=>{
  const combined=aggregateMediaAnalysis([positive,{...negative,sexual:"positive",sexualProbability:0.95}]);
  expect(combined.sexual).toBe("positive");expect(combined.disturbing).toBe("positive");expect(isMediaAnalysis(combined)).toBe(true);
  expect(()=>aggregateMediaAnalysis([])).toThrow("invalid_media_batch");
  expect(()=>aggregateMediaAnalysis([{...negative,sexualProbability:NaN}])).toThrow("invalid_media_batch");
});
it("preserves sampled-frame coverage through category aggregation",()=>{
  const sampled={...negative,frameSampling:{sampledFrameCount:3,totalFrameCount:10,attachmentCount:1}};
  const combined=aggregateMediaAnalysis([positive,sampled]);
  expect(combined.disturbing).toBe("positive");
  expect(combined.sexual).toBe("uncertain");
  expect(combined.frameSampling).toEqual({sampledFrameCount:3,totalFrameCount:10,attachmentCount:1});
  expect(isMediaAnalysis(combined)).toBe(true);
  expect(isMediaAnalysis({...combined,frameSampling:{sampledFrameCount:8,totalFrameCount:8,attachmentCount:3},videoSampling:{sampledFrameCount:8,durationSeconds:20,attachmentCount:2}})).toBe(false);
  expect(isMediaAnalysis({...sampled,frameSampling:{sampledFrameCount:1,totalFrameCount:10,attachmentCount:1}})).toBe(false);
  expect(isMediaAnalysis({...sampled,frameSampling:{sampledFrameCount:6,totalFrameCount:10,attachmentCount:1}})).toBe(false);
  const partial=aggregateMediaAnalysis([sampled,{...negative,frameSampling:{sampledFrameCount:3,totalFrameCount:20,attachmentCount:1}}]);
  expect(partial.frameSampling).toEqual({sampledFrameCount:6,totalFrameCount:30,attachmentCount:2});
  expect(partial.sexual).toBe("uncertain");expect(partial.disturbing).toBe("uncertain");
  expect(isMediaAnalysis(partial)).toBe(true);
});
it("sums video sampling metadata and keeps every sampled-only negative uncertain",()=>{
  const detail=interpretDisturbingProbabilities([0.1,0.8,0.1]);
  const video={...negative,sexual:"uncertain" as const,disturbing:detail.verdict,disturbingAnalysis:detail,videoSampling:{sampledFrameCount:5,durationSeconds:32,attachmentCount:1}};
  const combined=aggregateMediaAnalysis([video,{...video,videoSampling:{sampledFrameCount:4,durationSeconds:20,attachmentCount:1}}]);
  expect(combined.videoSampling).toEqual({sampledFrameCount:9,durationSeconds:52,attachmentCount:2});
  expect(combined.sexual).toBe("uncertain");expect(combined.disturbing).toBe("uncertain");
  expect(isMediaAnalysis(combined)).toBe(true);
  expect(isMediaAnalysis({...video,videoSampling:{sampledFrameCount:6,durationSeconds:32,attachmentCount:1}})).toBe(false);
  expect(isMediaAnalysis({...video,videoSampling:{sampledFrameCount:5,durationSeconds:121,attachmentCount:1}})).toBe(false);
});
