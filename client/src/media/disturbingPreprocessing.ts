// RGB-only compatibility with Pillow 13 Image.resize(..., BILINEAR): separable
// antialiased triangle filtering, 22-bit coefficients and per-pass byte rounding.
// Reference: python-pillow/Pillow src/libImaging/Resample.c. Not NSFWJS's
// alignCorners resize, and not timm's separate center-crop/bicubic path.
const side=224;
const precision=2**22;
export const DISTURBING_PREPROCESSOR="pillow13-bilinear-rgb-nchw";
type Filter={start:number;weights:Int32Array};
function filters(size:number):Filter[]{
  const scale=size/side,support=Math.max(1,scale);
  return Array.from({length:side},(_,destination)=>{
    const center=(destination+0.5)*scale;
    const start=Math.max(0,Math.trunc(center-support+0.5));
    const end=Math.min(size,Math.trunc(center+support+0.5));
    const coefficients=Array.from({length:end-start},(_,index)=>Math.max(0,1-Math.abs((start+index-center+0.5)*(1/support))));
    const total=coefficients.reduce((sum,value)=>sum+value,0);
    return {start,weights:Int32Array.from(coefficients,(value)=>Math.floor(0.5+value/total*precision))};
  });
}
const byte=(value:number)=>Math.max(0,Math.min(255,Math.floor((value+precision/2)/precision)));
function horizontalPass(rgb:Uint8Array,width:number,height:number):Uint8Array{
    if(width===side)return rgb;
    const horizontal=new Uint8Array(side*height*3);
    const axis=filters(width);
    for(let y=0;y<height;y++)for(let x=0;x<side;x++)for(let channel=0;channel<3;channel++){
      const {start,weights}=axis[x];let sum=0;
      for(let index=0;index<weights.length;index++)sum+=rgb[(y*width+start+index)*3+channel]*weights[index];
      horizontal[(y*side+x)*3+channel]=byte(sum);
    }
    return horizontal;
}
function verticalPass(rgb:Uint8Array,width:number,height:number):Uint8Array{
  if(height===side)return rgb;
  const output=new Uint8Array(width*side*3),axis=filters(height);
  for(let y=0;y<side;y++)for(let x=0;x<width;x++)for(let channel=0;channel<3;channel++){
    const {start,weights}=axis[y];let sum=0;
    for(let index=0;index<weights.length;index++)sum+=rgb[((start+index)*width+x)*3+channel]*weights[index];
    output[(y*width+x)*3+channel]=byte(sum);
  }
  return output;
}
export function resizeDisturbingRgb(rgb:Uint8Array,width:number,height:number):Uint8Array{
  if(!(rgb instanceof Uint8Array)||!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1||width>8192||height>8192||width*height>4_000_000||rgb.length!==width*height*3)throw new Error("disturbing_image_dimensions");
  // Pillow 13 changes pass order when vertical downscaling dominates. Keeping
  // horizontal-first unconditionally changes pixels due to intermediate rounding.
  const verticalFirst=height>side&&(height-side)>(width-side)*2;
  const result=verticalFirst
    ?horizontalPass(verticalPass(rgb,width,height),width,side)
    :verticalPass(horizontalPass(rgb,width,height),side,height);
  return result===rgb?result.slice():result;
}
/** ONNX graph already contains normalization/softmax: preserve 0..255 values. */
export function prepareDisturbingPixels(rgb:Uint8Array,width:number,height:number):Float32Array{
  const resized=resizeDisturbingRgb(rgb,width,height),plane=side*side;
  const output=new Float32Array(plane*3);
  for(let pixel=0;pixel<plane;pixel++)for(let channel=0;channel<3;channel++)output[channel*plane+pixel]=resized[pixel*3+channel];
  return output;
}
