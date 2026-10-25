export type MediaMode = "show" | "blur" | "block";
export type MediaScope = "friendDMs" | "otherDMs" | "channels";
export type MediaPolicy = Partial<Record<MediaScope, MediaMode>>;
import {isMediaAnalysis,type MediaAnalysis} from "../media/mediaClassifierContract";
const defaults: Record<MediaScope, MediaMode> = { friendDMs: "show", otherDMs: "blur", channels: "blur" };

export function unknownMediaMode(privacy: { sensitiveMedia?: MediaPolicy; disturbingMedia?: MediaPolicy } | undefined, scope: MediaScope): MediaMode {
  const modes = [privacy?.sensitiveMedia?.[scope] ?? defaults[scope], privacy?.disturbingMedia?.[scope] ?? defaults[scope]];
  return modes.includes("block") ? "block" : modes.includes("blur") ? "blur" : "show";
}

/** Only a validated negative can clear its own category, never the other one. */
export function automaticMediaMode(privacy:{sensitiveMedia?:MediaPolicy;disturbingMedia?:MediaPolicy}|undefined,scope:MediaScope,analysis?:MediaAnalysis):MediaMode {
  if(!isMediaAnalysis(analysis))return unknownMediaMode(privacy,scope);
  const modes=[analysis.sexual==="negative"?"show":privacy?.sensitiveMedia?.[scope]??defaults[scope],analysis.disturbing==="negative"?"show":privacy?.disturbingMedia?.[scope]??defaults[scope]];
  return modes.includes("block")?"block":modes.includes("blur")?"blur":"show";
}

/** An explicit account-private user annotation, not a claim of AI analysis. */
export function annotatedMediaMode(privacy:{sensitiveMedia?:MediaPolicy;disturbingMedia?:MediaPolicy}|undefined,scope:MediaScope,label?:string):MediaMode {
  if(label==="ordinary")return "show";
  if(label==="sexual")return privacy?.sensitiveMedia?.[scope]??defaults[scope];
  if(label==="disturbing")return privacy?.disturbingMedia?.[scope]??defaults[scope];
  // Both categories, invalid/missing annotations and classification failures
  // preserve the stricter unknown-media protection.
  return unknownMediaMode(privacy,scope);
}
