import * as tf from "@tensorflow/tfjs";
import {MEDIA_MODEL,sexualVerdict,type MediaAnalysis} from "./mediaClassifierContract";
export {MEDIA_MODEL,type MediaAnalysis} from "./mediaClassifierContract";

export function interpretMediaProbabilities(values: ArrayLike<number>): MediaAnalysis {
  if(values.length!==5)throw new Error("invalid_media_output");
  const scores=Array.from(values);
  if(scores.some((value)=>!Number.isFinite(value)||value<0||value>1)||Math.abs(scores.reduce((sum,value)=>sum+value,0)-1)>0.01)throw new Error("invalid_media_output");
  // Upstream order: Drawing, Hentai, Neutral, Porn, Sexy. This model has NO
  // violence/gore category; never interpret its Neutral class as that verdict.
  const sexualProbability=scores[1]+scores[3]+scores[4];
  return {model:MEDIA_MODEL.id,sexual:sexualVerdict(sexualProbability),disturbing:"unknown",sexualProbability};
}

export async function verifyMediaModelBytes(bytes:ArrayBuffer,expected:{bytes:number;sha256:string}) {
  if(bytes.byteLength!==expected.bytes)throw new Error("media_model_integrity");
  const digest=await crypto.subtle.digest("SHA-256",bytes);
  const hash=Array.from(new Uint8Array(digest),(value)=>value.toString(16).padStart(2,"0")).join("");
  if(hash!==expected.sha256)throw new Error("media_model_integrity");
}

/** Worker-only CPU backend. Never change the microphone/main-thread TF backend. */
export async function loadMediaModel(manifest:ArrayBuffer,weights:ArrayBuffer):Promise<tf.LayersModel> {
  await Promise.all([verifyMediaModelBytes(manifest,MEDIA_MODEL.manifest),verifyMediaModelBytes(weights,MEDIA_MODEL.weights)]);
  const json=JSON.parse(new TextDecoder().decode(manifest)) as {modelTopology:tf.io.ModelJSON["modelTopology"];weightsManifest:tf.io.WeightsManifestConfig};
  if(json.weightsManifest.length!==1||json.weightsManifest[0].paths.length!==1||json.weightsManifest[0].paths[0]!=="group1-shard1of1")throw new Error("media_model_manifest");
  await tf.setBackend("cpu");
  await tf.ready();
  return tf.loadLayersModel(tf.io.fromMemory({modelTopology:json.modelTopology,weightSpecs:json.weightsManifest[0].weights,weightData:weights}));
}

export async function predictMediaPixels(model:tf.LayersModel,rgb:Uint8Array,width:number,height:number):Promise<MediaAnalysis> {
  if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1||width*height>4_000_000||rgb.length!==width*height*3)throw new Error("media_dimensions");
  const output=tf.tidy(()=>{
    const image=tf.tensor3d(rgb,[height,width,3],"int32").toFloat().div(255);
    const resized=tf.image.resizeBilinear(image as tf.Tensor3D,[224,224],true);
    const prediction=model.predict(resized.reshape([1,224,224,3]));
    if(Array.isArray(prediction))throw new Error("invalid_media_output");
    return prediction;
  });
  try{return interpretMediaProbabilities(await output.data());}
  finally{output.dispose();}
}
