export const DISTURBING_MODEL = {
  id: "swiftformer-xs-54f4560-pillow13",
  model: {bytes:13137569,sha256:"8c28c49d9075f3ad15ebdc2961f02d5b3f99be944815b848b49c9f0e6f3fb689"},
  wasm: {bytes:14239897,sha256:"3398c10d07d229bd91b364548e130e0e51a8e5704b88c7c083ebbeb78842dee2"},
} as const;
export type DisturbingAnalysis = {
  model:typeof DISTURBING_MODEL.id;
  verdict:"positive"|"negative"|"uncertain";
  probability:number;
  sexualClassProbability:number;
  safeProbability:number;
};
/** Provisional thresholds; uncertain is not a safe verdict. */
export function interpretDisturbingProbabilities(values:ArrayLike<number>):DisturbingAnalysis {
  const scores=Array.from(values);
  if(scores.length!==3||scores.some(value=>!Number.isFinite(value)||value<0||value>1)||Math.abs(scores.reduce((sum,value)=>sum+value,0)-1)>0.001)throw new Error("invalid_disturbing_output");
  const [probability,sexualClassProbability,safeProbability]=scores;
  return {model:DISTURBING_MODEL.id,probability,sexualClassProbability,safeProbability,verdict:probability>=0.7?"positive":probability<=0.05&&safeProbability>=0.9?"negative":"uncertain"};
}
