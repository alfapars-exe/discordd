import {expect,it} from "vitest";
import {isMediaAnalysis,MEDIA_MODEL} from "./mediaClassifierContract";
import {interpretDisturbingProbabilities} from "./disturbingModelContract";
const base={model:MEDIA_MODEL.id,sexual:"negative",sexualProbability:0.01};
it("preserves valid float32 softmax evidence without reconstructing a negative residual",()=>{
  const detail=interpretDisturbingProbabilities(new Float32Array([0.2,0,0.8]));
  expect(isMediaAnalysis({...base,disturbing:detail.verdict,disturbingAnalysis:detail})).toBe(true);
});
it("accepts independent validated results and legacy unknown",()=>{
  expect(isMediaAnalysis({...base,disturbing:"unknown"})).toBe(true);
  for(const scores of [[0.8,0.1,0.1],[0.01,0.01,0.98],[0.1,0.8,0.1]]){
    const detail=interpretDisturbingProbabilities(scores);
    expect(isMediaAnalysis({...base,disturbing:detail.verdict,disturbingAnalysis:detail})).toBe(true);
  }
});
it("rejects unsupported, missing, inconsistent or impossible category evidence",()=>{
  const detail=interpretDisturbingProbabilities([0.01,0.01,0.98]);
  for(const value of [
    {...base,disturbing:"negative"},
    {...base,disturbing:"unknown",disturbingAnalysis:detail},
    {...base,disturbing:"positive",disturbingAnalysis:detail},
    {...base,disturbing:"negative",disturbingAnalysis:{...detail,model:"untrusted"}},
    {...base,disturbing:"negative",disturbingAnalysis:{...detail,probability:NaN}},
    {...base,disturbing:"negative",disturbingAnalysis:{...detail,safeProbability:1.1}},
    {...base,disturbing:"negative",disturbingAnalysis:{...detail,sexualClassProbability:undefined}},
    {...base,disturbing:"negative",disturbingAnalysis:{...detail,sexualClassProbability:NaN}},
    {...base,disturbing:"negative",disturbingAnalysis:{...detail,sexualClassProbability:0.8}},
  ])expect(isMediaAnalysis(value)).toBe(false);
});
