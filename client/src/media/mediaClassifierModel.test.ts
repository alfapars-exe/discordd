// @vitest-environment node
import {readFile} from "node:fs/promises";
import {afterAll,beforeAll,expect,it} from "vitest";
import * as tf from "@tensorflow/tfjs";
import {interpretMediaProbabilities,loadMediaModel,MEDIA_MODEL,predictMediaPixels,verifyMediaModelBytes} from "./mediaClassifierModel";

let model:tf.LayersModel;
const asset=async(name:string)=>{
  const bytes=await readFile(new URL(`../../public/media-classifier/v1/${name}`,import.meta.url));
  return Uint8Array.from(bytes).buffer;
};
beforeAll(async()=>{model=await loadMediaModel(await asset("model.json"),await asset("group1-shard1of1"));},30000);
afterAll(()=>model?.dispose());
// Each real inference gets its own bounded budget: V8 coverage substantially
// slows CPU kernels on shared CI runners. Check tensor cleanup for every input.
it.each([0,127,255])("runs the actual pinned model on CPU without leaking prediction tensors (input %i)",async(value)=>{
  expect(tf.getBackend()).toBe("cpu");
  const before=tf.memory().numTensors;
  const result=await predictMediaPixels(model,new Uint8Array(12*8*3).fill(value),12,8);
  expect(result.model).toBe(MEDIA_MODEL.id);
  expect(result.sexualProbability).toBeGreaterThanOrEqual(0);
  expect(result.sexualProbability).toBeLessThanOrEqual(1.001);
  expect(result.disturbing).toBe("unknown");
  expect(tf.memory().numTensors).toBe(before);
},30000);
it("rejects corrupted assets before deserialization",async()=>{
  const bytes=await asset("group1-shard1of1");
  new Uint8Array(bytes)[0]^=1;
  await expect(verifyMediaModelBytes(bytes,MEDIA_MODEL.weights)).rejects.toThrow("media_model_integrity");
  await expect(verifyMediaModelBytes(new ArrayBuffer(2),MEDIA_MODEL.manifest)).rejects.toThrow("media_model_integrity");
});
it("does not turn missing/invalid/uncertain scores into a general safe verdict",()=>{
  expect(interpretMediaProbabilities([0.1,0.2,0.1,0.4,0.2]).sexual).toBe("positive");
  expect(interpretMediaProbabilities([0.5,0,0.5,0,0])).toMatchObject({sexual:"negative",disturbing:"unknown"});
  expect(interpretMediaProbabilities([0.3,0.2,0.2,0.2,0.1]).sexual).toBe("uncertain");
  for(const scores of [[],[0,0,0,0,0],[NaN,0,0,0,1],[-1,0,1,0,1]])expect(()=>interpretMediaProbabilities(scores)).toThrow("invalid_media_output");
});
it("rejects malformed pixel shapes before inference",async()=>{
  await expect(predictMediaPixels(model,new Uint8Array(3),0,1)).rejects.toThrow("media_dimensions");
  await expect(predictMediaPixels(model,new Uint8Array(3),1,2)).rejects.toThrow("media_dimensions");
});
