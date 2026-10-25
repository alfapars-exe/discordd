import {create} from "zustand";
import {getAuthSessionSnapshot,subscribeAuthGenerationChanges,subscribeAuthOwnerChanges} from "../api/authSessionEvents";
export type GroupCallAudioControl={nonce:string;accountId:string;generation:number;groupId:string;manualMuted:boolean;effectiveMuted:boolean;blocked:boolean;toggle:()=>void};
const current=(control:GroupCallAudioControl)=>{const auth=getAuthSessionSnapshot();return auth.ownerId===control.accountId&&auth.generation===control.generation;};
/** Ephemeral control routing only; never keeps a call alive after navigation. */
export const useGroupCallAudioControlStore=create<{control:GroupCallAudioControl|null}>(()=>({control:null}));
export function bindGroupCallAudioControl(control:GroupCallAudioControl){
 if(!current(control))return;
 const toggle=()=>{const active=useGroupCallAudioControlStore.getState().control;if(active?.nonce===control.nonce&&current(control)&&!active.blocked)control.toggle();};
 useGroupCallAudioControlStore.setState({control:{...control,toggle}});
}
export function releaseGroupCallAudioControl(nonce:string){if(useGroupCallAudioControlStore.getState().control?.nonce===nonce)useGroupCallAudioControlStore.setState({control:null});}
export function toggleGroupCallMicrophone(nonce:string){const control=useGroupCallAudioControlStore.getState().control;if(control?.nonce===nonce&&current(control)&&!control.blocked)control.toggle();}
const retire=()=>{const control=useGroupCallAudioControlStore.getState().control;if(control&&!current(control))useGroupCallAudioControlStore.setState({control:null});};
subscribeAuthOwnerChanges(retire);subscribeAuthGenerationChanges(retire);
