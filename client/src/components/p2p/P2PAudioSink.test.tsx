import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import P2PAudioSink from './P2PAudioSink';
import P2PCallScreen from './P2PCallScreen';
import {useP2PCallStore} from '../../stores/p2pCallStore';
import {useVoiceStore} from '../../stores/voiceStore';
import {useAuthStore} from '../../stores/authStore';
import {clearTokens} from '../../api/client';
import {playP2PAudio} from '../../audio/p2pPlayback';
import type {P2PCall} from '../../types';
vi.mock('../../audio/p2pPlayback',()=>({playP2PAudio:vi.fn()}));
vi.mock('react-i18next',async original=>({...await original<typeof import('react-i18next')>(),useTranslation:()=>({t:(key:string)=>key})}));
vi.mock('./P2PCallControls',()=>({default:()=>null}));
vi.mock('../shared/Avatar',()=>({default:()=>null}));
const call={id:'call',caller_id:'viewer',receiver_id:'peer',caller_username:'Viewer',receiver_username:'Peer',status:'active',call_type:'video'} as P2PCall;
const stream=()=>({getVideoTracks:()=>[{enabled:true}],getAudioTracks:()=>[]} as unknown as MediaStream);
let players:{ready:Promise<{fallback:boolean}>;stop:ReturnType<typeof vi.fn>;setVolume:ReturnType<typeof vi.fn>}[];
beforeEach(()=>{
 clearTokens();useAuthStore.setState({user:{id:'viewer'} as never});players=[];
 vi.mocked(playP2PAudio).mockReset().mockImplementation(()=>{const p={ready:Promise.resolve({fallback:false}),stop:vi.fn(),setVolume:vi.fn()};players.push(p);return p;});
 useVoiceStore.setState({outputDevice:'speaker',masterVolume:50,userVolumes:{peer:20},localMutedUsers:{},isDeafened:false,isServerDeafened:false});
 useP2PCallStore.setState({activeCall:{...call},remoteStream:stream(),localStream:null,peerConnection:{} as RTCPeerConnection});
});
afterEach(cleanup);
it('uses local selected output and master times personal volume, preserving zero, local mute and both deafen flags',async()=>{
 render(<P2PAudioSink/>);await act(async()=>{});
 expect(playP2PAudio).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({outputDevice:'speaker',volume:0.1}));
 for(const patch of [{masterVolume:0},{masterVolume:50,userVolumes:{peer:0}},{userVolumes:{peer:150},isDeafened:true},{isDeafened:false,isServerDeafened:true},{isServerDeafened:false,localMutedUsers:{peer:true}}]){act(()=>useVoiceStore.setState(patch));expect(players[0].setVolume).toHaveBeenLastCalledWith(0);}
 act(()=>useVoiceStore.setState({localMutedUsers:{},masterVolume:100,userVolumes:{peer:150}}));expect(players[0].setVolume).toHaveBeenLastCalledWith(1.5);
 expect(useP2PCallStore.getState().isMuted).toBe(false);
});
it.each(['output','stream','connection','call','end','owner','generation'] as const)('stops obsolete playback and invalidates its async source after %s transition',async kind=>{
 const view=render(<P2PAudioSink/>);await act(async()=>{});const old=vi.mocked(playP2PAudio).mock.calls[0][1];expect(old.isCurrent()).toBe(true);
 act(()=>{
  if(kind==='output')useVoiceStore.setState({outputDevice:''});
  if(kind==='stream')useP2PCallStore.setState({remoteStream:stream()});
  if(kind==='connection')useP2PCallStore.setState({peerConnection:{} as RTCPeerConnection});
  if(kind==='call')useP2PCallStore.setState({activeCall:{...call,id:'replacement'}});
  if(kind==='end')useP2PCallStore.setState({activeCall:null});
  if(kind==='owner')useAuthStore.setState({user:{id:'foreign'} as never});
  if(kind==='generation')clearTokens();
 });
 expect(players[0].stop).toHaveBeenCalled();expect(old.isCurrent()).toBe(false);
 view.unmount();for(const player of players)expect(player.stop).toHaveBeenCalled();
});
it('reports an actual failure and retries explicitly; stale ready results cannot clear a replacement failure',async()=>{
 let ready!:(value:{fallback:boolean})=>void;vi.mocked(playP2PAudio).mockImplementationOnce(()=>{const p={ready:new Promise<{fallback:boolean}>(resolve=>{ready=resolve;}),stop:vi.fn(),setVolume:vi.fn()};players.push(p);return p;});
 render(<P2PAudioSink/>);act(()=>vi.mocked(playP2PAudio).mock.calls[0][1].onFailure(new Error('blocked')));expect(screen.getByRole('alert')).toHaveTextContent('p2pAudioFailed');
 fireEvent.click(screen.getByText('p2pAudioRetry'));expect(playP2PAudio).toHaveBeenCalledTimes(2);
 act(()=>vi.mocked(playP2PAudio).mock.calls[1][1].onFailure(new Error('still blocked')));
 await act(async()=>{ready({fallback:false});});expect(screen.getByRole('alert')).toHaveTextContent('p2pAudioFailed');
});
it('shows actual missing-device fallback and never mounts a second audible remote video',async()=>{
 vi.mocked(playP2PAudio).mockImplementationOnce(()=>{const p={ready:Promise.resolve({fallback:true}),stop:vi.fn(),setVolume:vi.fn()};players.push(p);return p;});
 const view=render(<><P2PAudioSink/><P2PCallScreen/></>);await act(async()=>{});
 expect(screen.getByRole('status')).toHaveTextContent('p2pAudioFallback');
 const video=view.container.querySelector('video.p2p-remote-video') as HTMLVideoElement;expect(video).toBeTruthy();expect(video.muted).toBe(true);expect(video.srcObject).toBe(useP2PCallStore.getState().remoteStream);
});
it('does not render stale failure status or borrow a foreign/nonactive call',async()=>{
 render(<P2PAudioSink/>);act(()=>vi.mocked(playP2PAudio).mock.calls[0][1].onFailure(new Error('old')));
 act(()=>useP2PCallStore.setState({remoteStream:stream()}));expect(screen.queryByRole('alert')).toBeNull();await act(async()=>{});
 const count=vi.mocked(playP2PAudio).mock.calls.length;act(()=>useP2PCallStore.setState({activeCall:{...call,caller_id:'other',receiver_id:'foreign'}}));expect(playP2PAudio).toHaveBeenCalledTimes(count);
});

it('never adopts a retained stream after same-account relogin or switching to the other participant',async()=>{
 const view=render(<P2PAudioSink/>);await act(async()=>{});const count=vi.mocked(playP2PAudio).mock.calls.length;
 act(()=>clearTokens());expect(playP2PAudio).toHaveBeenCalledTimes(count);expect(players[0].stop).toHaveBeenCalled();
 act(()=>useAuthStore.setState({user:{id:'peer'} as never}));expect(playP2PAudio).toHaveBeenCalledTimes(count);
 view.unmount();render(<P2PAudioSink/>);expect(playP2PAudio).toHaveBeenCalledTimes(count);
});
