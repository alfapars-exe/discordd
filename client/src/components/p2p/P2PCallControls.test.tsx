import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import P2PCallControls from './P2PCallControls';
import {useP2PCallStore} from '../../stores/p2pCallStore';
import {useVoiceStore} from '../../stores/voiceStore';
vi.mock('react-i18next',async original=>({...await original<typeof import('react-i18next')>(),useTranslation:()=>({t:(key:string)=>key})}));
const toggle=vi.fn();
beforeEach(()=>{toggle.mockReset();useP2PCallStore.setState({activeCall:{id:'call',status:'active',call_type:'voice'} as never,isMuted:true,toggleMute:toggle});useVoiceStore.setState({isDeafened:true});});
afterEach(cleanup);
it('labels private queued manual intent while its microphone remains effectively muted by local deafen',()=>{
 render(<P2PCallControls/>);const button=screen.getByRole('button',{name:'unmuteAfterUndeafen'});expect(button).toHaveAttribute('aria-pressed','true');fireEvent.click(button);expect(toggle).toHaveBeenCalledOnce();
 act(()=>useP2PCallStore.setState({isMuted:false}));expect(screen.getByRole('button',{name:'muteAfterUndeafen'})).toHaveAttribute('aria-pressed','true');
 act(()=>useVoiceStore.setState({isDeafened:false}));expect(screen.getByRole('button',{name:'toggleMic'})).toHaveAttribute('aria-pressed','false');
});
