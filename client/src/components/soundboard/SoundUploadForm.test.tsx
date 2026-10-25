import {beforeEach,expect,it,vi} from 'vitest';
import {act,fireEvent,render,screen,waitFor} from '@testing-library/react';
const h=vi.hoisted(()=>({current:true,create:vi.fn(),renderClip:vi.fn(),preview:vi.fn(),created:vi.fn(),metas:[] as EventTarget[], blobs:new Map<string,Blob>()}));
vi.mock('react-i18next',()=>({useTranslation:()=>({t:(s:string)=>s})}));
vi.mock('../shared/EmojiPicker',()=>({default:()=>null}));
vi.mock('./WaveformTrimmer',()=>({default:({onTrimChange,onTogglePlay}:{onTrimChange:(a:number,b:number)=>void;onTogglePlay:()=>void})=><><button onClick={()=>onTrimChange(2000,4000)}>Trim</button><button onClick={onTogglePlay}>Preview</button></>}));
vi.mock('../../api/soundboard',()=>({createSound:(...a:unknown[])=>h.create(...a)}));
vi.mock('../../utils/wavEncode',()=>({renderClipToWav:(...a:unknown[])=>h.renderClip(...a),audioBufferToWav:()=>new Blob(['converted'],{type:'audio/wav'})}));
vi.mock('../../stores/soundboardStore',()=>({captureSoundboardScope:()=>({serverId:'connected-a'}),isSoundboardScopeCurrent:()=>h.current,useSoundboardStore:Object.assign((select:(s:{error:null})=>unknown)=>select({error:null}),{getState:()=>({previewSound:h.preview,handleSoundCreate:h.created})})}));
import SoundUploadForm from './SoundUploadForm';
function clip(){const bytes=new ArrayBuffer(44+96000);const v=new DataView(bytes);v.setUint32(24,24000,true);v.setUint16(32,2,true);v.setUint32(40,96000,true);const blob=new Blob([bytes],{type:'audio/wav'});Object.defineProperty(blob,'arrayBuffer',{value:async()=>bytes});return blob;}
beforeEach(()=>{vi.clearAllMocks();h.current=true;h.metas=[];h.blobs.clear();vi.stubGlobal('Audio',class extends EventTarget{duration=10;constructor(){super();h.metas.push(this);}pause(){}});vi.stubGlobal('URL',Object.assign(class {},{createObjectURL:vi.fn((blob:Blob)=>{const url='blob:'+h.blobs.size;h.blobs.set(url,blob);return url;}),revokeObjectURL:vi.fn()}));h.renderClip.mockResolvedValue(clip());h.preview.mockReturnValue({ready:Promise.resolve({fallback:false}),isActive:()=>true,stop:vi.fn()});h.create.mockResolvedValue({success:false,error:'offline'});});
async function draft(){const onClose=vi.fn();const view=render(<SoundUploadForm onClose={onClose}/>);fireEvent.change(view.container.querySelector('input[type=file]')!,{target:{files:[new File(['original'],'song.mp3',{type:'audio/mpeg'})]}});act(()=>{h.metas[0].dispatchEvent(new Event('loadedmetadata'));});fireEvent.click(await screen.findByText('Trim'));return onClose;}
it('previews selected encoded frames and submits the identical cached clip to connected server; failed upload keeps draft',async()=>{const onClose=await draft();fireEvent.click(screen.getByText('Preview'));await waitFor(()=>expect(h.preview).toHaveBeenCalledOnce());expect(h.renderClip).toHaveBeenCalledWith(expect.any(File),2000,4000);const previewBlob=h.blobs.get(h.preview.mock.calls[0][0]);expect(previewBlob).toBeDefined();fireEvent.click(screen.getByText('upload'));await waitFor(()=>expect(h.create).toHaveBeenCalledOnce());const [server,file,name,duration]=h.create.mock.calls[0];expect(server).toBe('connected-a');expect(file.type).toBe('audio/wav');expect(file.size).toBe(previewBlob!.size);expect(name).toBe('song');expect(duration).toBe(2000);expect(h.renderClip).toHaveBeenCalledOnce();expect(await screen.findByText('offline')).toBeInTheDocument();expect(screen.getByDisplayValue('song')).toBeInTheDocument();expect(onClose).not.toHaveBeenCalled();});
it('does not upload decoded clip after voice/account scope changes',async()=>{await draft();let finish!:(b:Blob)=>void;h.renderClip.mockReturnValueOnce(new Promise<Blob>(resolve=>{finish=resolve;}));fireEvent.click(screen.getByText('upload'));h.current=false;finish(clip());await Promise.resolve();await Promise.resolve();expect(h.create).not.toHaveBeenCalled();});

function deferred<T>(){let resolve!:(value:T)=>void;let reject!:(reason:Error)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
function video(name:string){const file=new File(['video'],name,{type:'video/mp4'});Object.defineProperty(file,'arrayBuffer',{value:async()=>new ArrayBuffer(1)});return file;}
it('keeps the latest file when an older video conversion resolves later',async()=>{
 const first=deferred<AudioBuffer>(),second=deferred<AudioBuffer>();
 const decode=vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
 vi.stubGlobal('AudioContext',class{decodeAudioData=decode;close=vi.fn().mockResolvedValue(undefined);});
 const view=render(<SoundUploadForm onClose={vi.fn()}/>);const input=view.container.querySelector('input[type=file]')!;
 fireEvent.change(input,{target:{files:[video('first.mp4')]}});
 await waitFor(()=>expect(decode).toHaveBeenCalledTimes(1));
 fireEvent.change(input,{target:{files:[video('second.mp4')]}});
 await waitFor(()=>expect(decode).toHaveBeenCalledTimes(2));
 await act(async()=>{second.resolve({} as AudioBuffer);});
 expect(h.metas).toHaveLength(1);
 act(()=>{h.metas[0].dispatchEvent(new Event('loadedmetadata'));});
 await act(async()=>{first.resolve({} as AudioBuffer);});
 expect(h.metas).toHaveLength(1);
 fireEvent.click(screen.getByText('upload'));
 await waitFor(()=>expect(h.create).toHaveBeenCalledOnce());
 expect(h.create.mock.calls[0][1].name).toBe('second.wav');
});
it('ignores old metadata as soon as another file starts converting, including a failed replacement',async()=>{
 const next=deferred<AudioBuffer>();vi.stubGlobal('AudioContext',class{decodeAudioData=()=>next.promise;close=vi.fn().mockResolvedValue(undefined);});
 const view=render(<SoundUploadForm onClose={vi.fn()}/>);const input=view.container.querySelector('input[type=file]')!;
 fireEvent.change(input,{target:{files:[new File(['old'],'old.mp3',{type:'audio/mpeg'})]}});
 fireEvent.change(input,{target:{files:[video('replacement.mp4')]}});
 act(()=>{h.metas[0].dispatchEvent(new Event('loadedmetadata'));});
 expect(screen.getByText('upload')).toBeDisabled();
 await act(async()=>{next.reject(new Error('bad video'));});
 expect(screen.getByText('videoConvertError')).toBeInTheDocument();
 expect(screen.getByText('upload')).toBeDisabled();expect(h.create).not.toHaveBeenCalled();
});
it('visibly freezes file and draft edits while preview preparation or upload is pending',async()=>{
 const onClose=await draft();const rendered=deferred<Blob>();h.renderClip.mockReturnValueOnce(rendered.promise);
 fireEvent.click(screen.getByText('Preview'));
 expect(document.querySelector('input[type=file]')).toBeDisabled();expect(screen.getByDisplayValue('song')).toBeDisabled();
 await act(async()=>{rendered.resolve(clip());});
 await waitFor(()=>expect(document.querySelector('input[type=file]')).not.toBeDisabled());
 const uploaded=deferred<{success:boolean;error:string}>();h.create.mockReturnValueOnce(uploaded.promise);
 fireEvent.click(screen.getByText('upload'));
 await waitFor(()=>expect(h.create).toHaveBeenCalledOnce());
 expect(document.querySelector('input[type=file]')).toBeDisabled();expect(screen.getByDisplayValue('song')).toBeDisabled();expect(screen.getByText('emojiPlaceholder')).toBeDisabled();
 fireEvent.change(screen.getByDisplayValue('song'),{target:{value:'new draft'}});
 expect(screen.getByDisplayValue('song')).toBeInTheDocument();
 await act(async()=>{uploaded.resolve({success:false,error:'offline'});});
 expect(screen.getByDisplayValue('song')).not.toBeDisabled();expect(onClose).not.toHaveBeenCalled();
});
