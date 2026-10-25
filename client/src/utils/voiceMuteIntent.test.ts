import {expect,it} from 'vitest';
import {normalizeVoiceMuteIntent,toggleVoiceDeafenIntent,toggleVoiceMuteIntent} from './voiceMuteIntent';
it.each([true,false])('restores manual mute=%s after explicit undeafen',muted=>{
 const original=normalizeVoiceMuteIntent({isMuted:muted});const deaf=toggleVoiceDeafenIntent(original);
 expect(deaf).toEqual({isMuted:true,isDeafened:true,muteBeforeDeafen:muted});expect(toggleVoiceDeafenIntent(deaf)).toEqual(original);
});
it('queues manual changes without turning off deafen or enabling capture',()=>{
 const deaf=toggleVoiceDeafenIntent(normalizeVoiceMuteIntent({isMuted:true}));const unmute=toggleVoiceMuteIntent(deaf);
 expect(unmute).toEqual({isMuted:true,isDeafened:true,muteBeforeDeafen:false});expect(toggleVoiceDeafenIntent(unmute).isMuted).toBe(false);
 const muteAgain=toggleVoiceMuteIntent(unmute);expect(muteAgain.isMuted).toBe(true);expect(toggleVoiceDeafenIntent(muteAgain).isMuted).toBe(true);
});
it('normalizes legacy deaf state conservatively and roundtrips new device-local intent',()=>{
 expect(normalizeVoiceMuteIntent({isMuted:false,isDeafened:true})).toEqual({isMuted:true,isDeafened:true,muteBeforeDeafen:true});
 expect(toggleVoiceDeafenIntent(normalizeVoiceMuteIntent({isMuted:true,isDeafened:true})).isMuted).toBe(true);
 const state=toggleVoiceDeafenIntent(normalizeVoiceMuteIntent({isMuted:false}));expect(normalizeVoiceMuteIntent(JSON.parse(JSON.stringify(state)))).toEqual(state);
 expect(normalizeVoiceMuteIntent(null)).toEqual({isMuted:false,isDeafened:false,muteBeforeDeafen:null});
});
