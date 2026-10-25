import fs from "node:fs/promises";
import {createHash} from "node:crypto";
import {CANDIDATE,interpretCandidateProbabilities} from "./verify-disturbing-model-candidate.mjs";

const base=new URL("../client/public/media-classifier/v2/",import.meta.url);
const assets={
  "model.onnx":[CANDIDATE.bytes,CANDIDATE.sha256],
  "ort.wasm.min.mjs":[50126,"219e6a1fc8a9938268d18efca3c91d310bd2f4a59bbd13744df5b2b7fc6cee3b"],
  "ort-wasm-simd-threaded.mjs":[24381,"e13f7f94fc51b4ca72b12faeb1ee95f4ace6dfbc8939bc718aabdc0a27c4299b"],
  "ort-wasm-simd-threaded.wasm":[14239897,"3398c10d07d229bd91b364548e130e0e51a8e5704b88c7c083ebbeb78842dee2"],
};

try {
  const provenance=JSON.parse(await fs.readFile(new URL("provenance.json",base),"utf8"));
  if(provenance.schema_version!==1||provenance.model?.bytes!==CANDIDATE.bytes||provenance.model?.sha256!==CANDIDATE.sha256||provenance.runtime?.version!==CANDIDATE.runtime)throw new Error("provenance_contract");
  const declared=new Map((provenance.runtime.assets??[]).map(asset=>[asset.path,asset]));
  for(const [name,[size,hash]] of Object.entries(assets)){
    if(name==="model.onnx")continue;
    const artifact=declared.get(name);
    if(!artifact||artifact.bytes!==size||artifact.sha256!==hash)throw new Error(`provenance_asset: ${name}`);
  }
  for(const name of [provenance.model.model_card,provenance.model.base_license,provenance.runtime.license,provenance.runtime.third_party_notices,provenance.preprocessing?.license]){
    if(typeof name!=="string"||name.includes("/")||name.includes("\\")||!(await fs.readFile(new URL(name,base),"utf8")).trim())throw new Error("provenance_notice");
  }
  const verified={};
  for(const [name,[size,hash]] of Object.entries(assets)){
    const bytes=await fs.readFile(new URL(name,base));
    if(bytes.length!==size||createHash("sha256").update(bytes).digest("hex")!==hash)throw new Error(`asset_integrity: ${name}`);
    verified[name]=bytes;
  }
  const ort=await import(new URL("ort.wasm.min.mjs",base).href);
  if(ort.env.versions.web!==CANDIDATE.runtime)throw new Error("runtime_version");
  ort.env.wasm.numThreads=1;
  ort.env.wasm.proxy=false;
  ort.env.wasm.wasmBinary=verified["ort-wasm-simd-threaded.wasm"];
  ort.env.wasm.wasmPaths={mjs:new URL("ort-wasm-simd-threaded.mjs",base).href};
  const session=await ort.InferenceSession.create(verified["model.onnx"],{executionProviders:["wasm"]});
  try {
    if(session.inputNames.join()!=="image"||session.outputNames.join()!=="probabilities")throw new Error("model_signature");
    const tensor=new ort.Tensor("float32",new Float32Array(3*224*224).fill(127),[1,3,224,224]);
    let outputs;
    try {
      outputs=await session.run({image:tensor});
      const result=interpretCandidateProbabilities(Array.from(outputs.probabilities.data));
      console.log(JSON.stringify({assetsVerified:Object.keys(assets),runtime:ort.env.versions.web,result,limitation:"Synthetic vendored-runtime probe; not browser or classification-accuracy acceptance."}));
    } finally {
      tensor.dispose();
      if(outputs)for(const output of Object.values(outputs))output.dispose();
    }
  } finally {await session.release();}
} catch(error) {
  // Avoid dumping a minified third-party module and obscuring the actual error.
  console.error(String(error).slice(0,1500));
  process.exitCode=1;
}
