// @vitest-environment node
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {MEDIA_MODEL} from "./mediaClassifierContract";
import {interpretDisturbingProbabilities} from "./disturbingModelContract";
const mocks=vi.hoisted(()=>({load:vi.fn(),sexual:vi.fn(),disturbing:vi.fn(),pixels:vi.fn(),read:vi.fn()}));
vi.mock("./mediaClassifierModel",async()=>({...await import("./mediaClassifierContract"),loadMediaModel:mocks.load,predictMediaPixels:mocks.sexual}));
vi.mock("./disturbingModelRuntime",()=>({loadDisturbingModel:mocks.disturbing}));
vi.mock("./mediaModelAssets",()=>({readExactMediaAsset:mocks.read}));
const negative={model:MEDIA_MODEL.id,sexual:"negative",sexualProbability:0.01,disturbing:"unknown"};
let port:{location:{origin:string};postMessage:ReturnType<typeof vi.fn>;onmessage?:(event:MessageEvent)=>Promise<void>};
let close:ReturnType<typeof vi.fn>;
let decoderControl:{frameCount:number;incomplete?:boolean;decoded:number[];closeCount:number;frameCloseCounts:number[]}|undefined;
class FakeImageDecoder {
  static isTypeSupported=vi.fn(async()=>true);
  tracks:{ready:Promise<void>;selectedTrack:{animated:boolean;frameCount:number}};
  complete=true;
  completed=Promise.resolve();
  constructor(){this.tracks={ready:Promise.resolve(),selectedTrack:{animated:true,frameCount:decoderControl?.frameCount??2}};}
  decode=async({frameIndex}:{frameIndex:number})=>{
    if(!decoderControl)throw new Error("missing decoder fixture");
    decoderControl.decoded.push(frameIndex);
    const frameClose=()=>{const index=decoderControl!.frameCloseCounts.length-1;decoderControl!.frameCloseCounts[index]++;};decoderControl.frameCloseCounts.push(0);
    return {complete:!decoderControl.incomplete,image:{displayWidth:1,displayHeight:1,close:frameClose}};
  };
  close=()=>{if(decoderControl)decoderControl.closeCount++;};
}
beforeEach(async()=>{
  vi.resetModules();vi.clearAllMocks();
  port={location:{origin:"https://local.test"},postMessage:vi.fn()};
  close=vi.fn();vi.stubGlobal("self",port);
  vi.stubGlobal("fetch",vi.fn(async()=>({ok:true})));
  vi.stubGlobal("createImageBitmap",vi.fn(async()=>({width:1,height:1,close})));
  vi.stubGlobal("OffscreenCanvas",class {getContext(){return {drawImage:vi.fn(),getImageData:()=>({data:new Uint8ClampedArray([10,20,30,255])})};}});
  mocks.read.mockResolvedValue(new ArrayBuffer(0));mocks.load.mockResolvedValue({});
  mocks.sexual.mockImplementation(async()=>({...negative}));
  mocks.pixels.mockResolvedValue(interpretDisturbingProbabilities([0.8,0.1,0.1]));
  mocks.disturbing.mockResolvedValue({predict:mocks.pixels});
  decoderControl=undefined;FakeImageDecoder.isTypeSupported.mockReset().mockResolvedValue(true);
  await import("./mediaClassifier.worker");
});
afterEach(()=>vi.unstubAllGlobals());
async function run(id=1,mime="image/jpeg"){
  const bytes=mime==="image/gif"?gif(2):new Uint8Array([255,216,255]);
  await port.onmessage!({data:{id,file:new Blob([bytes],{type:mime}),modelBase:"https://local.test/media-classifier/v1/"}} as MessageEvent);
}
function gif(frameCount:number){
  const bytes=new Uint8Array(13+frameCount*14+1);bytes.set(new TextEncoder().encode("GIF89a"));new DataView(bytes.buffer).setUint16(6,1,true);new DataView(bytes.buffer).setUint16(8,1,true);
  let offset=13;const view=new DataView(bytes.buffer);for(let index=0;index<frameCount;index++){bytes[offset++]=0x2c;view.setUint16(offset+4,1,true);view.setUint16(offset+6,1,true);offset+=8;bytes[offset++]=0;bytes[offset++]=2;bytes[offset++]=1;bytes[offset++]=0;bytes[offset++]=0;}bytes[offset]=0x3b;return bytes;
}
function apng(){
  const chunks:{type:string;data:Uint8Array}[]=[{type:"IHDR",data:new Uint8Array(13)},{type:"acTL",data:new Uint8Array(8)}];
  new DataView(chunks[0].data.buffer).setUint32(0,1);new DataView(chunks[0].data.buffer).setUint32(4,1);new DataView(chunks[1].data.buffer).setUint32(0,2);
  for(let index=0;index<2;index++){const control=new Uint8Array(26);new DataView(control.buffer).setUint32(4,1);new DataView(control.buffer).setUint32(8,1);chunks.push({type:"fcTL",data:control},{type:index===0?"IDAT":"fdAT",data:new Uint8Array(index===0?1:5)});}
  chunks.push({type:"IEND",data:new Uint8Array(0)});const bytes=new Uint8Array(8+chunks.reduce((total,chunk)=>total+12+chunk.data.length,0));bytes.set([137,80,78,71,13,10,26,10]);
  let offset=8;for(const chunk of chunks){new DataView(bytes.buffer).setUint32(offset,chunk.data.length);bytes.set(new TextEncoder().encode(chunk.type),offset+4);bytes.set(chunk.data,offset+8);offset+=12+chunk.data.length;}return bytes;
}
function animatedWebp(){
  const chunks=[{type:"VP8X",data:new Uint8Array(10)},{type:"ANIM",data:new Uint8Array(6)}];chunks[0].data[0]=2;
  for(let index=0;index<2;index++){const data=new Uint8Array(16);chunks.push({type:"ANMF",data});}
  const length=12+chunks.reduce((total,chunk)=>total+8+chunk.data.length,0);const bytes=new Uint8Array(length);bytes.set(new TextEncoder().encode("RIFF"));new DataView(bytes.buffer).setUint32(4,length-8,true);bytes.set(new TextEncoder().encode("WEBP"),8);
  let offset=12;for(const chunk of chunks){bytes.set(new TextEncoder().encode(chunk.type),offset);new DataView(bytes.buffer).setUint32(offset+4,chunk.data.length,true);bytes.set(chunk.data,offset+8);offset+=8+chunk.data.length;}return bytes;
}
it("runs independent models on the same RGB pixels and returns category evidence",async()=>{
  await run();
  expect(mocks.disturbing).toHaveBeenCalledWith("https://local.test/media-classifier/v2/");
  expect(mocks.pixels).toHaveBeenCalledWith(new Uint8Array([10,20,30]),1,1);
  expect(port.postMessage).toHaveBeenCalledWith({id:1,analysis:{...negative,disturbing:"positive",disturbingAnalysis:interpretDisturbingProbabilities([0.8,0.1,0.1])}});
  expect(close).toHaveBeenCalledOnce();
});
it("accepts only transferred bounded bitmaps and closes them after classification",async()=>{
  const bitmap={width:1,height:1,close:vi.fn()};
  await port.onmessage!({data:{id:3,bitmap,modelBase:"https://local.test/media-classifier/v1/"}} as MessageEvent);
  expect(mocks.sexual).toHaveBeenCalledWith(expect.anything(),new Uint8Array([10,20,30]),1,1);
  expect(bitmap.close).toHaveBeenCalledOnce();
  expect(port.postMessage.mock.lastCall?.[0].analysis).toBeDefined();
});
it("retains sexual evidence on disturbing load failure and retries on next work",async()=>{
  mocks.disturbing.mockRejectedValueOnce(new Error("private model internals"));
  await run();expect(port.postMessage).toHaveBeenLastCalledWith({id:1,analysis:negative});
  await run(2);expect(mocks.disturbing).toHaveBeenCalledTimes(2);
  expect(port.postMessage.mock.lastCall?.[0].analysis.disturbing).toBe("positive");
  expect(close).toHaveBeenCalledTimes(2);
});
it("does not report a safe category after inference failure",async()=>{
  mocks.pixels.mockRejectedValueOnce(new Error("sensitive internal failure"));
  await run();expect(port.postMessage).toHaveBeenCalledWith({id:1,analysis:negative});
  expect(JSON.stringify(port.postMessage.mock.calls)).not.toContain("sensitive");
});
it("rejects video/unsupported media without decoding or loading models",async()=>{
  await run(1,"video/mp4");
  expect(port.postMessage).toHaveBeenCalledWith({id:1,error:"media_unsupported"});
  expect(createImageBitmap).not.toHaveBeenCalled();expect(mocks.load).not.toHaveBeenCalled();expect(mocks.disturbing).not.toHaveBeenCalled();
});
it("samples a deterministic bounded subset, closes each frame, and reports incomplete coverage",async()=>{
  decoderControl={frameCount:10,decoded:[],closeCount:0,frameCloseCounts:[]};
  vi.stubGlobal("ImageDecoder",FakeImageDecoder);
  mocks.pixels.mockResolvedValue(interpretDisturbingProbabilities([0.01,0.01,0.98]));
  const bytes=gif(10);
  await port.onmessage!({data:{id:8,file:new Blob([bytes],{type:"image/gif"}),modelBase:"https://local.test/media-classifier/v1/"}} as MessageEvent);
  expect(decoderControl.decoded).toEqual([0,2,5,7,9]);
  expect(decoderControl.frameCloseCounts).toEqual([1,1,1,1,1]);
  expect(decoderControl.closeCount).toBe(1);
  expect(port.postMessage.mock.lastCall?.[0].analysis.frameSampling).toEqual({sampledFrameCount:5,totalFrameCount:10,attachmentCount:1});
  expect(port.postMessage.mock.lastCall?.[0].analysis.sexual).toBe("uncertain");
  expect(port.postMessage.mock.lastCall?.[0].analysis.disturbing).toBe("uncertain");
  expect(mocks.sexual).toHaveBeenCalledTimes(5);
});
it.each([["image/png",apng],["image/webp",animatedWebp]] as const)("decodes animated %s through the bounded frame path",async(mime,makeBytes)=>{
  decoderControl={frameCount:2,decoded:[],closeCount:0,frameCloseCounts:[]};vi.stubGlobal("ImageDecoder",FakeImageDecoder);
  const bytes=makeBytes();await port.onmessage!({data:{id:11,file:new Blob([bytes],{type:mime}),modelBase:"https://local.test/media-classifier/v1/"}} as MessageEvent);
  expect(decoderControl.decoded).toEqual([0,1]);expect(decoderControl.closeCount).toBe(1);
  expect(port.postMessage.mock.lastCall?.[0].analysis.frameSampling).toEqual({sampledFrameCount:2,totalFrameCount:2,attachmentCount:1});
});
it("lets any sampled positive dominate uncertainty while retaining the sample boundary",async()=>{
  decoderControl={frameCount:3,decoded:[],closeCount:0,frameCloseCounts:[]};vi.stubGlobal("ImageDecoder",FakeImageDecoder);
  const positive={...negative,sexual:"positive",sexualProbability:0.9,disturbing:"positive",disturbingAnalysis:interpretDisturbingProbabilities([0.8,0.1,0.1])};
  const uncertain={...negative,sexual:"uncertain",sexualProbability:0.5,disturbing:"uncertain",disturbingAnalysis:interpretDisturbingProbabilities([0.1,0.8,0.1])};
  mocks.sexual.mockResolvedValueOnce(negative).mockResolvedValueOnce(positive).mockResolvedValueOnce(uncertain);
  await port.onmessage!({data:{id:9,file:new Blob([gif(3)],{type:"image/gif"}),modelBase:"https://local.test/media-classifier/v1/"}} as MessageEvent);
  const output=port.postMessage.mock.lastCall?.[0].analysis;
  expect(output.disturbing).toBe("positive");expect(output.sexual).toBe("positive");
  expect(output.frameSampling).toEqual({sampledFrameCount:3,totalFrameCount:3,attachmentCount:1});
});
it("fails closed and releases decoder/frame if a sampled frame is incomplete",async()=>{
  decoderControl={frameCount:2,incomplete:true,decoded:[],closeCount:0,frameCloseCounts:[]};vi.stubGlobal("ImageDecoder",FakeImageDecoder);
  await port.onmessage!({data:{id:10,file:new Blob([gif(2)],{type:"image/gif"}),modelBase:"https://local.test/media-classifier/v1/"}} as MessageEvent);
  expect(port.postMessage).toHaveBeenCalledWith({id:10,error:"media_analysis_failed"});
  expect(decoderControl.frameCloseCounts[0]).toBe(1);expect(decoderControl.closeCount).toBe(1);
  expect(mocks.sexual).not.toHaveBeenCalled();
});
it("cleans the decoded bitmap and returns only a generic error on sexual failure",async()=>{
  mocks.sexual.mockRejectedValueOnce(new Error("private image contents"));
  await run();
  expect(port.postMessage).toHaveBeenCalledWith({id:1,error:"media_analysis_failed"});
  expect(close).toHaveBeenCalledOnce();expect(mocks.disturbing).not.toHaveBeenCalled();
  await run(2);expect(port.postMessage.mock.lastCall?.[0].analysis.disturbing).toBe("positive");
});
