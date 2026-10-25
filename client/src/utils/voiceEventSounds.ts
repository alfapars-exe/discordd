import { playVoiceEventSound, type VoiceSoundEvent } from "./sounds";
export type ManualVoiceState = { manualMuted: boolean; deafened: boolean };
/** One logical call/controller owns this baseline. Only actual commit may emit. */
export class ManualVoiceSoundTracker {
 private state: ManualVoiceState;
 private pending: VoiceSoundEvent | null = null;
 private current:()=>boolean;
 private play:(event:VoiceSoundEvent)=>void;
 constructor(initial: ManualVoiceState, current:()=>boolean, play:(event:VoiceSoundEvent)=>void=playVoiceEventSound){this.state={...initial};this.current=current;this.play=play;}
 observe(next:ManualVoiceState){
  if(!this.current()){this.pending=null;return;}
  if(next.deafened!==this.state.deafened)this.pending=next.deafened?null:"undeafen";
  else if(next.manualMuted!==this.state.manualMuted&&!next.deafened)this.pending=next.manualMuted?"mute":"unmute";
  this.state={...next};
 }
 commit(next:ManualVoiceState,outputEnabled:boolean){
  if(!this.current()||next.manualMuted!==this.state.manualMuted||next.deafened!==this.state.deafened)return;
  if(next.deafened){this.pending=null;return;}
  const event=this.pending;
  if(event==="mute"&&outputEnabled||event==="unmute"&&!outputEnabled){this.pending=null;return;}
  this.pending=null;if(event)this.play(event);
 }
 reject(){this.pending=null;}
}
