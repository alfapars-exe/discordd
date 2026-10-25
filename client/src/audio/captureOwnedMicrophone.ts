import {LocalAudioTrack,Track}from "livekit-client";
import {captureConstraints,type MicrophoneSettings}from "./microphoneSettings";
/** Public SDK defaults retained, with one app-owned raw capture and no silent
 * device fallback. User-provided ownership disables SDK automatic reacquisition. */
export async function captureOwnedMicrophone(settings:MicrophoneSettings,current:()=>boolean){
 const constraints:MediaTrackConstraints & {voiceIsolation:boolean}={voiceIsolation:true,...captureConstraints(settings),deviceId:settings.inputDevice?{exact:settings.inputDevice}:{ideal:"default"}};
 if(!current())throw new DOMException("Obsolete microphone capture","AbortError");
 const stream=await navigator.mediaDevices.getUserMedia({audio:constraints,video:false});
 try{
  if(!current())throw new DOMException("Obsolete microphone capture","AbortError");
  const source=stream.getAudioTracks()[0];if(!source||source.readyState==="ended")throw new Error("Microphone returned no live source");
  const track=new LocalAudioTrack(source,{...constraints,deviceId:source.getSettings().deviceId??constraints.deviceId},true);track.source=Track.Source.Microphone;
  return{track,source};
 }catch(error){stream.getTracks().forEach(track=>track.stop());throw error;}
}
