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

it('surfaces exact-call microphone recovery separately from queued manual mute and focused PTT',()=>{
 const call=useP2PCallStore.getState().activeCall!,retry=vi.fn().mockResolvedValue(false);useP2PCallStore.setState({microphoneFailure:{call,ownerId:"owner",generation:1},microphoneRetrying:false,retryMicrophone:retry});useVoiceStore.setState({inputDevice:"missing",inputMode:"push_to_talk",isDeafened:false});
 const view=render(<P2PCallControls/>);expect(screen.getByRole('alert')).toHaveTextContent('p2pMicrophoneUnavailable');expect(screen.getByRole('status')).toHaveTextContent('p2pFocusedPTT');
 fireEvent.click(screen.getByRole('button',{name:'microphoneCaptureRetry'}));expect(retry).toHaveBeenCalledWith(call);
 fireEvent.click(screen.getByRole('button',{name:'microphoneUseDefault'}));expect(retry).toHaveBeenCalledWith(call,true);
 act(()=>useP2PCallStore.setState({microphoneRetrying:true}));expect(screen.getByRole('button',{name:'microphoneCaptureRetry'})).toBeDisabled();
 act(()=>useP2PCallStore.setState({activeCall:{...call,id:'replacement'}}));expect(screen.queryByRole('alert')).toBeNull();view.unmount();
});
