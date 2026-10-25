import {getAuthSessionSnapshot,subscribeAuthGenerationChanges,subscribeAuthOwnerChanges}from "../api/authSessionEvents";
import {useShortcutCaptureStore}from "../stores/shortcutCaptureStore";
import {isElectron}from "../utils/constants";
export const nativePTTAvailable=()=>isElectron()&&typeof window.electronAPI?.acquirePTTLease==="function"&&typeof window.electronAPI?.onPTTLeaseSignal==="function"&&typeof window.electronAPI?.releasePTTLease==="function";
/** Callback signals are scoped to one immutable source/auth lease, never media authority. */
export function bindNativePTT(options:{kind:"guild"|"p2p"|"group";source:string;keyCode:string;current:()=>boolean;onPressed:(pressed:boolean)=>void;onUnavailable?:()=>void;onReady?:()=>void}):()=>void {
 if(!nativePTTAvailable()){let cancelled=false;queueMicrotask(()=>{if(!cancelled)options.onUnavailable?.();});return()=>{cancelled=true;};}
 const api=window.electronAPI!,auth=JSON.stringify(getAuthSessionSnapshot());
 let active=true,id:string|null=null,pressed=false,composing=false;
 const editable=(value:EventTarget|null)=>value instanceof Element&&!!value.closest("input,textarea,select,[contenteditable],[role=textbox]");
 const inputBlocked=()=>document.hasFocus()&&(composing||editable(document.activeElement));
 const current=()=>{try{return active&&JSON.stringify(getAuthSessionSnapshot())===auth&&options.current()&&!useShortcutCaptureStore.getState().active;}catch{return false;}};
 const release=(lease:string)=>{void api.releasePTTLease(lease).catch(()=>{});};
 const unlisten=api.onPTTLeaseSignal(signal=>{
  if(!active||signal.leaseId!==id)return;
  if(!current()){stop();return;}
  const next=signal.pressed&&!inputBlocked();if(next===pressed)return;pressed=next;options.onPressed(next);
 });
 const silence=()=>{if(pressed){pressed=false;options.onPressed(false);}};
 const focus=(event:FocusEvent)=>{if(editable(event.target))silence();};
 const compositionStart=()=>{composing=true;silence();};
 const compositionEnd=()=>{composing=false;};
 document.addEventListener("focusin",focus);document.addEventListener("compositionstart",compositionStart);document.addEventListener("compositionend",compositionEnd);
 const stop=()=>{if(!active)return;active=false;unlisten();document.removeEventListener("focusin",focus);document.removeEventListener("compositionstart",compositionStart);document.removeEventListener("compositionend",compositionEnd);owner();generation();capture();if(pressed){pressed=false;options.onPressed(false);}if(id)release(id);};
 const retire=()=>{if(!current())stop();};
 const owner=subscribeAuthOwnerChanges(retire),generation=subscribeAuthGenerationChanges(retire),capture=useShortcutCaptureStore.subscribe(retire);
 if(!current()){stop();return stop;}
 void api.acquirePTTLease({kind:options.kind,source:options.source,keyCode:options.keyCode}).then(lease=>{
  if(!lease){if(active)options.onUnavailable?.();stop();return;}
  if(!current()){release(lease);stop();return;}id=lease;options.onReady?.();
 }).catch(()=>{if(active)options.onUnavailable?.();stop();});
 return stop;
}
