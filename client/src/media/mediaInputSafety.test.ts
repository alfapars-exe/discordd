import {expect,it} from "vitest";
import {inspectAnimatedRaster,isSupportedStaticImage,sampleFrameIndexes} from "./mediaInputSafety";
function png(animated:boolean){
  const chunks=animated?[{type:"IHDR",size:13},{type:"acTL",size:8},{type:"IEND",size:0}]:[{type:"IHDR",size:13},{type:"IEND",size:0}];
  const bytes=new Uint8Array(8+chunks.reduce((sum,chunk)=>sum+12+chunk.size,0));
  bytes.set([137,80,78,71,13,10,26,10]);
  let offset=8;
  for(const chunk of chunks){new DataView(bytes.buffer).setUint32(offset,chunk.size);bytes.set(new TextEncoder().encode(chunk.type),offset+4);offset+=12+chunk.size;}
  return bytes;
}
function webp(animation:boolean){
  const bytes=new Uint8Array(38);
  bytes.set(new TextEncoder().encode("RIFF"));new DataView(bytes.buffer).setUint32(4,30,true);bytes.set(new TextEncoder().encode("WEBPVP8X"),8);new DataView(bytes.buffer).setUint32(16,10,true);bytes[20]=animation?2:0;bytes.set(new TextEncoder().encode("VP8 "),30);
  return bytes;
}
function apng(frameCount=2,width=1,height=1){
  const chunks=[{type:"IHDR",data:new Uint8Array(13)},{type:"acTL",data:new Uint8Array(8)}];
  new DataView(chunks[0].data.buffer).setUint32(0,width);new DataView(chunks[0].data.buffer).setUint32(4,height);
  new DataView(chunks[1].data.buffer).setUint32(0,frameCount);
  for(let frame=0;frame<frameCount;frame++){
    const control=new Uint8Array(26);const view=new DataView(control.buffer);view.setUint32(4,width);view.setUint32(8,height);
    chunks.push({type:"fcTL",data:control});
    chunks.push({type:frame===0?"IDAT":"fdAT",data:new Uint8Array(frame===0?1:5)});
  }
  chunks.push({type:"IEND",data:new Uint8Array(0)});
  const bytes=new Uint8Array(8+chunks.reduce((sum,chunk)=>sum+12+chunk.data.length,0));bytes.set([137,80,78,71,13,10,26,10]);
  let offset=8;for(const chunk of chunks){new DataView(bytes.buffer).setUint32(offset,chunk.data.length);bytes.set(new TextEncoder().encode(chunk.type),offset+4);bytes.set(chunk.data,offset+8);offset+=12+chunk.data.length;}
  return bytes;
}
function gif(frameCount=2,width=1,height=1){
  const bytes=new Uint8Array(13+frameCount*14+1);bytes.set(new TextEncoder().encode("GIF89a"));
  const view=new DataView(bytes.buffer);view.setUint16(6,width,true);view.setUint16(8,height,true);
  let offset=13;for(let frame=0;frame<frameCount;frame++){bytes[offset++]=0x2c;view.setUint16(offset,0,true);view.setUint16(offset+2,0,true);view.setUint16(offset+4,width,true);view.setUint16(offset+6,height,true);offset+=8;bytes[offset++]=0;bytes[offset++]=2;bytes[offset++]=1;bytes[offset++]=0;bytes[offset++]=0;}
  bytes[offset]=0x3b;return bytes;
}
function animatedWebp(frameCount=2,width=1,height=1){
  const chunks:{type:string;data:Uint8Array}[]=[{type:"VP8X",data:new Uint8Array(10)},{type:"ANIM",data:new Uint8Array(6)}];
  chunks[0].data[0]=2;const view=new DataView(chunks[0].data.buffer);view.setUint32(0,2,true);
  chunks[0].data[4]=(width-1)&255;chunks[0].data[5]=((width-1)>>8)&255;chunks[0].data[6]=((width-1)>>16)&255;
  chunks[0].data[7]=(height-1)&255;chunks[0].data[8]=((height-1)>>8)&255;chunks[0].data[9]=((height-1)>>16)&255;
  for(let frame=0;frame<frameCount;frame++){const data=new Uint8Array(16);data[6]=width-1;data[9]=height-1;chunks.push({type:"ANMF",data});}
  const length=12+chunks.reduce((sum,chunk)=>sum+8+chunk.data.length+(chunk.data.length%2),0);const bytes=new Uint8Array(length);
  bytes.set(new TextEncoder().encode("RIFF"));new DataView(bytes.buffer).setUint32(4,length-8,true);bytes.set(new TextEncoder().encode("WEBP"),8);
  let offset=12;for(const chunk of chunks){bytes.set(new TextEncoder().encode(chunk.type),offset);new DataView(bytes.buffer).setUint32(offset+4,chunk.data.length,true);bytes.set(chunk.data,offset+8);offset+=8+chunk.data.length+(chunk.data.length%2);}
  return bytes;
}
it("rejects animated PNG/WebP rather than calling their first frame safe",()=>{
  expect(isSupportedStaticImage(png(false),"image/png")).toBe(true);
  expect(isSupportedStaticImage(png(true),"image/png")).toBe(false);
  expect(isSupportedStaticImage(webp(false),"image/webp")).toBe(true);
  expect(isSupportedStaticImage(webp(true),"image/webp")).toBe(false);
});
it("rejects truncated, oversized-chunk and unsupported containers",()=>{
  const bytes=png(false);new DataView(bytes.buffer).setUint32(8,0xffffffff);
  expect(isSupportedStaticImage(bytes,"image/png")).toBe(false);
  expect(isSupportedStaticImage(png(false).subarray(0,25),"image/png")).toBe(false);
  for(const mime of ["image/gif","image/svg+xml","video/mp4","text/html"])expect(isSupportedStaticImage(new Uint8Array([255,216,255]),mime)).toBe(false);
  expect(isSupportedStaticImage(new Uint8Array([255,216,255]),"image/jpeg")).toBe(true);
});
it("preflights GIF, APNG, and animated WebP canvases and frame counts",()=>{
  for(const [bytes,mime] of [[gif(),"image/gif"],[apng(),"image/png"],[animatedWebp(),"image/webp"]] as const)
    expect(inspectAnimatedRaster(bytes,mime)).toEqual({frameCount:2,width:1,height:1});
  expect(inspectAnimatedRaster(apng(1),"image/png")).toBeNull();
  expect(inspectAnimatedRaster(gif(2,2001,2000),"image/gif")).toBeNull();
  expect(inspectAnimatedRaster(gif().subarray(0,-1),"image/gif")).toBeNull();
  expect(inspectAnimatedRaster(animatedWebp(2,2001,2000),"image/webp")).toBeNull();
});
it("selects at most five deterministic frames including first, middle, and last",()=>{
  expect(sampleFrameIndexes(2)).toEqual([0,1]);
  expect(sampleFrameIndexes(5)).toEqual([0,1,2,3,4]);
  expect(sampleFrameIndexes(10)).toEqual([0,2,5,7,9]);
  expect(sampleFrameIndexes(1)).toEqual([]);
  expect(sampleFrameIndexes(100_001)).toEqual([0,25_000,50_000,75_000,100_000]);
});
