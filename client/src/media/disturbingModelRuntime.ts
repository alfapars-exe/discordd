import {DISTURBING_MODEL,interpretDisturbingProbabilities} from "./disturbingModelContract";
import {prepareDisturbingPixels} from "./disturbingPreprocessing";
import {readExactMediaAsset} from "./mediaModelAssets";

interface Tensor {
  data:ArrayLike<number>;
  dims:readonly number[];
  dispose():void;
}
interface Session {
  inputNames:readonly string[];
  outputNames:readonly string[];
  run(input:Record<string,Tensor>):Promise<Record<string,Tensor>>;
  release():Promise<void>;
}
interface Runtime {
  env:{versions:{web:string};wasm:{numThreads:number;proxy:boolean;wasmBinary:Uint8Array;wasmPaths:{mjs:string}}};
  Tensor:new(type:string,data:Float32Array,dimensions:number[])=>Tensor;
  InferenceSession:{create(bytes:Uint8Array,options:{executionProviders:string[]}):Promise<Session>};
}

async function asset(root:URL,name:string,expected:{bytes:number;sha256:string}) {
  const response=await fetch(new URL(name,root),{credentials:"omit",redirect:"error",signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw new Error("disturbing_model_unavailable");
  const bytes=await readExactMediaAsset(response,expected.bytes);
  const hash=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",bytes)),value=>value.toString(16).padStart(2,"0")).join("");
  if(hash!==expected.sha256)throw new Error("disturbing_model_integrity");
  return new Uint8Array(bytes);
}

/** Worker-only, local standalone runtime; no CDN or media uploads. */
export async function loadDisturbingModel(base:string) {
  const root=new URL(base);
  if(root.origin!==self.location.origin||!root.pathname.endsWith("/media-classifier/v2/")||root.search||root.hash||root.username||root.password)throw new Error("disturbing_model_origin");
  const [model,wasm]=await Promise.all([asset(root,"model.onnx",DISTURBING_MODEL.model),asset(root,"ort-wasm-simd-threaded.wasm",DISTURBING_MODEL.wasm)]);
  // These JS modules are shipped as trusted application assets. Model and WASM
  // bytes are additionally pinned at runtime; the packaging probe checks all four.
  const runtime=await import(/* @vite-ignore */ new URL("ort.wasm.min.mjs",root).href) as Runtime;
  if(runtime.env.versions.web!=="1.30.0")throw new Error("disturbing_runtime_version");
  runtime.env.wasm.numThreads=1;
  runtime.env.wasm.proxy=false;
  runtime.env.wasm.wasmBinary=wasm;
  runtime.env.wasm.wasmPaths={mjs:new URL("ort-wasm-simd-threaded.mjs",root).href};
  const session=await runtime.InferenceSession.create(model,{executionProviders:["wasm"]});
  if(session.inputNames.join()!=="image"||session.outputNames.join()!=="probabilities"){
    await session.release();throw new Error("disturbing_model_signature");
  }
  return createDisturbingPredictor(runtime,session);
}

/** Shared production inference/lifetime path, also exercised with faulting sessions. */
export function createDisturbingPredictor(runtime:Pick<Runtime,"Tensor">,session:Session) {
  let disposed=false;
  return {
    async predict(rgb:Uint8Array,width:number,height:number) {
      if(disposed)throw new Error("disturbing_model_disposed");
      const input=new runtime.Tensor("float32",prepareDisturbingPixels(rgb,width,height),[1,3,224,224]);
      let outputs:Record<string,Tensor>|undefined;
      try {
        outputs=await session.run({image:input});
        if(!outputs.probabilities||outputs.probabilities.dims.join()!=="1,3")throw new Error("invalid_disturbing_output");
        return interpretDisturbingProbabilities(outputs.probabilities.data);
      } finally {
        input.dispose();
        if(outputs)for(const output of Object.values(outputs))output.dispose();
      }
    },
    async dispose(){if(!disposed){disposed=true;await session.release();}},
  };
}
