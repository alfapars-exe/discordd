// @vitest-environment node
import {readFile} from "node:fs/promises";
import {createHash} from "node:crypto";
import {expect,it} from "vitest";
import {createDisturbingPredictor} from "./disturbingModelRuntime";
import {DISTURBING_MODEL} from "./disturbingModelContract";

it("runs the actual local ONNX model through the production pixel/lifetime adapter",async()=>{
  const base=new URL("../../public/media-classifier/v2/",import.meta.url);
  const model=await readFile(new URL("model.onnx",base));
  const wasm=await readFile(new URL("ort-wasm-simd-threaded.wasm",base));
  for(const [bytes,expected] of [[model,DISTURBING_MODEL.model],[wasm,DISTURBING_MODEL.wasm]] as const){
    expect(bytes.byteLength).toBe(expected.bytes);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(expected.sha256);
  }
  type Session=Parameters<typeof createDisturbingPredictor>[1];
  type Runtime=Parameters<typeof createDisturbingPredictor>[0]&{
    env:{versions:{web:string};wasm:{numThreads:number;proxy:boolean;wasmBinary:Uint8Array;wasmPaths:{mjs:string}}};
    InferenceSession:{create(bytes:Uint8Array,options:{executionProviders:string[]}):Promise<Session>};
  };
  const runtime=await import(/* @vite-ignore */ new URL("ort.wasm.min.mjs",base).href) as Runtime;
  expect(runtime.env.versions.web).toBe("1.30.0");
  runtime.env.wasm.numThreads=1;runtime.env.wasm.proxy=false;
  runtime.env.wasm.wasmBinary=wasm;
  runtime.env.wasm.wasmPaths={mjs:new URL("ort-wasm-simd-threaded.mjs",base).href};
  const session=await runtime.InferenceSession.create(model,{executionProviders:["wasm"]});
  expect(session.inputNames).toEqual(["image"]);expect(session.outputNames).toEqual(["probabilities"]);
  const predictor=createDisturbingPredictor(runtime,session);
  try {
    for(const value of [0,127,255]){
      const result=await predictor.predict(new Uint8Array(19*11*3).fill(value),19,11);
      expect(result.model).toBe(DISTURBING_MODEL.id);
      expect(result.probability).toBeGreaterThanOrEqual(0);
      expect(result.safeProbability).toBeLessThanOrEqual(1);
      expect(["positive","negative","uncertain"]).toContain(result.verdict);
    }
  } finally {await predictor.dispose();}
  await expect(predictor.predict(new Uint8Array(3),1,1)).rejects.toThrow("disturbing_model_disposed");
},30000);
