import fs from "node:fs/promises";
import crypto from "node:crypto";
import {createRequire} from "node:module";
import {resolve} from "node:path";
import {fileURLToPath} from "node:url";

export const CANDIDATE={
  repository:"OwenElliott/image-safety-classifier-xs",
  revision:"54f4560bd9c5ee92d45dc30418a8f8680e80de6d",
  bytes:13137569,
  sha256:"8c28c49d9075f3ad15ebdc2961f02d5b3f99be944815b848b49c9f0e6f3fb689",
  runtime:"1.30.0",
};

/** Provisional evaluation rule only; not a deployed/calibrated safety policy. */
export function interpretCandidateProbabilities(scores){
  if(scores.length!==3||scores.some(value=>!Number.isFinite(value)||value<0||value>1)||Math.abs(scores.reduce((a,b)=>a+b,0)-1)>0.001)throw new Error("invalid_candidate_output");
  const [nsfl,nsfw,sfw]=scores;
  // A low gore score by itself is not sufficient when another unsafe class wins.
  const verdict=nsfl>=0.7?"positive":nsfl<=0.05&&sfw>=0.9?"negative":"uncertain";
  return {verdict,nsfl,nsfw,sfw};
}

export async function probeCandidate(modelPath,runtimeRoot){
  const require=createRequire(resolve(runtimeRoot,"package.json"));
  const ort=require("onnxruntime-web");
  if(ort.env.versions.web!==CANDIDATE.runtime)throw new Error("candidate_runtime_version");
  ort.env.wasm.numThreads=1;ort.env.wasm.proxy=false;ort.env.logLevel="fatal";
  const bytes=await fs.readFile(modelPath);
  const sha256=crypto.createHash("sha256").update(bytes).digest("hex");
  if(bytes.length!==CANDIDATE.bytes||sha256!==CANDIDATE.sha256)throw new Error("candidate_integrity");
  const began=performance.now();
  const session=await ort.InferenceSession.create(bytes,{executionProviders:["wasm"],graphOptimizationLevel:"all"});
  const loadMs=performance.now()-began;
  const runs=[];
  try{
    if(session.inputNames.length!==1||session.inputNames[0]!=="image"||session.outputNames.length!==1||session.outputNames[0]!=="probabilities")throw new Error("candidate_signature");
    for(const value of [0,127,255,127,127,127]){
      const input=new ort.Tensor("float32",new Float32Array(3*224*224).fill(value),[1,3,224,224]);
      let outputs;
      try{
        const start=performance.now();outputs=await session.run({image:input});
        const elapsedMs=performance.now()-start;
        const scores=Array.from(outputs.probabilities.data);
        runs.push({syntheticLevel:value,scores,...interpretCandidateProbabilities(scores),elapsedMs});
      }finally{input.dispose();if(outputs)for(const output of Object.values(outputs))output.dispose();}
    }
    return {candidate:CANDIDATE,runtime:ort.env.versions,input:session.inputMetadata,output:session.outputMetadata,loadMs,runs,rssBytes:process.memoryUsage().rss,limitation:"Synthetic inference/compatibility probe only; not model accuracy, preprocessing parity, browser or real-device acceptance."};
  }finally{await session.release();}
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv.length!==4)throw new Error("Usage: node scripts/verify-disturbing-model-candidate.mjs <model.onnx> <isolated-runtime-directory>");
  console.log(JSON.stringify(await probeCandidate(resolve(process.argv[2]),resolve(process.argv[3]))));
}
