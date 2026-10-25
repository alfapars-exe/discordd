import {expect,it} from "vitest";
import {annotatedMediaMode,automaticMediaMode} from "./mediaVisibility";
import {MEDIA_MODEL} from "../media/mediaClassifierContract";
import {interpretDisturbingProbabilities} from "../media/disturbingModelContract";
const privacy={sensitiveMedia:{channels:"blur" as const},disturbingMedia:{channels:"block" as const}};
it("clears each category only with validated negative evidence",()=>{
  const base={model:MEDIA_MODEL.id,sexual:"negative" as const,sexualProbability:0.01};
  for(const scores of [[0.8,0.1,0.1],[0.1,0.8,0.1],[0.01,0.01,0.98]]){
    const detail=interpretDisturbingProbabilities(scores);
    const analysis={...base,disturbing:detail.verdict,disturbingAnalysis:detail};
    expect(automaticMediaMode(privacy,"channels",analysis)).toBe(detail.verdict==="negative"?"show":"block");
    expect(automaticMediaMode(privacy,"channels",{...analysis,sexual:"positive",sexualProbability:0.95})).toBe(detail.verdict==="negative"?"blur":"block");
  }
  expect(automaticMediaMode(privacy,"channels",{...base,disturbing:"negative"})).toBe("block");
});
it("applies independent categories only for explicit known user annotations",()=>{
  expect(annotatedMediaMode(privacy,"channels","sexual")).toBe("blur");
  expect(annotatedMediaMode(privacy,"channels","disturbing")).toBe("block");
  expect(annotatedMediaMode(privacy,"channels","both")).toBe("block");
  expect(annotatedMediaMode(privacy,"channels","ordinary")).toBe("show");
});
it("a negative sexual result never clears the unknown disturbing-content category",()=>{
  const result={model:MEDIA_MODEL.id,sexual:"negative" as const,disturbing:"unknown" as const,sexualProbability:0.01};
  expect(automaticMediaMode(privacy,"channels",result)).toBe("block");
  expect(automaticMediaMode({sensitiveMedia:{channels:"block"},disturbingMedia:{channels:"show"}},"channels",result)).toBe("show");
  expect(automaticMediaMode({sensitiveMedia:{channels:"block"},disturbingMedia:{channels:"show"}},"channels",{...result,sexual:"positive",sexualProbability:0.95})).toBe("block");
});
it("does not treat sampled-only animation negatives as safe",()=>{
  const detail=interpretDisturbingProbabilities([0.01,0.01,0.98]);
  const partial={model:MEDIA_MODEL.id,sexual:"uncertain" as const,sexualProbability:0.01,disturbing:"uncertain" as const,disturbingAnalysis:detail,frameSampling:{sampledFrameCount:5,totalFrameCount:12,attachmentCount:1}};
  expect(automaticMediaMode(privacy,"channels",partial)).toBe("block");
});
it.each([undefined,"safe-by-ai","pending","error"])("keeps unknown/error values %s protected",label=>{
  expect(annotatedMediaMode(privacy,"channels",label)).toBe("block");
});
