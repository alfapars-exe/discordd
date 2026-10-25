// @vitest-environment node
import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {expect,it} from "vitest";
import {prepareDisturbingPixels,resizeDisturbingRgb} from "./disturbingPreprocessing";
type Case={width:number;height:number;seed:number;rgb_sha256:string;nchw_sha256:string};
const reference=JSON.parse(readFileSync(new URL("./fixtures/disturbing-preprocessing-pillow13.json",import.meta.url),"utf8")) as {cases:Case[]};
function rgb(width:number,height:number,seed:number){
  let state=seed;const bytes=new Uint8Array(width*height*3);
  for(let index=0;index<bytes.length;index++){state=(Math.imul(state,1664525)+1013904223)>>>0;bytes[index]=state>>>24;}
  return bytes;
}
const hash=(bytes:Uint8Array)=>createHash("sha256").update(bytes).digest("hex");
it.each(reference.cases)("matches actual Pillow pixels and NCHW bytes for $width x $height",(item)=>{
  const source=rgb(item.width,item.height,item.seed);
  expect(hash(resizeDisturbingRgb(source,item.width,item.height))).toBe(item.rgb_sha256);
  const tensor=prepareDisturbingPixels(source,item.width,item.height);
  const bytes=new Uint8Array(tensor.length*4),view=new DataView(bytes.buffer);
  tensor.forEach((value,index)=>view.setFloat32(index*4,value,true));
  expect(hash(bytes)).toBe(item.nchw_sha256);
});
it("preserves channel order and 0..255 values without normalizing twice",()=>{
  const source=new Uint8Array([255,127,3]);
  const output=prepareDisturbingPixels(source,1,1);
  expect(output[0]).toBe(255);expect(output[224*224]).toBe(127);expect(output[2*224*224]).toBe(3);
  expect([...source]).toEqual([255,127,3]);
});
it("rejects malformed or pathological dimensions before intermediate allocation",()=>{
  for(const [width,height] of [[0,1],[1,0],[NaN,1],[1.5,1],[1,8193],[8193,1],[2001,2001]])expect(()=>prepareDisturbingPixels(new Uint8Array(3),width,height)).toThrow("disturbing_image_dimensions");
  expect(()=>prepareDisturbingPixels(new Uint8Array(3),1,2)).toThrow("disturbing_image_dimensions");
});
