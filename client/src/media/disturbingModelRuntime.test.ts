import {describe,expect,it,vi} from "vitest";
import {createDisturbingPredictor,loadDisturbingModel} from "./disturbingModelRuntime";

function fixture(scores=[0.01,0.01,0.98],dims=[1,3]) {
  const inputDispose=vi.fn(),outputDispose=vi.fn(),release=vi.fn(async()=>{});
  let captured:Float32Array|undefined;
  class Tensor {
    data:Float32Array;
    dims:number[];
    dispose=inputDispose;
    constructor(type:string,data:Float32Array,shape:number[]){expect(type).toBe("float32");this.data=data;this.dims=shape;captured=data;}
  }
  const run=vi.fn(async()=>({probabilities:{data:scores,dims,dispose:outputDispose}}));
  const predictor=createDisturbingPredictor({Tensor},{inputNames:["image"],outputNames:["probabilities"],run,release});
  return {predictor,run,release,inputDispose,outputDispose,get captured(){return captured;}};
}

describe("disturbing runtime production inference path",()=>{
  it("uses RGB 0..255 NCHW without applying embedded normalization twice",async()=>{
    const f=fixture();
    expect((await f.predictor.predict(new Uint8Array([10,20,30]),1,1)).verdict).toBe("negative");
    expect(f.captured?.[0]).toBe(10);
    expect(f.captured?.[224*224]).toBe(20);
    expect(f.captured?.[2*224*224]).toBe(30);
    expect(f.inputDispose).toHaveBeenCalledOnce();expect(f.outputDispose).toHaveBeenCalledOnce();
    await f.predictor.dispose();await f.predictor.dispose();
    expect(f.release).toHaveBeenCalledOnce();
    await expect(f.predictor.predict(new Uint8Array(3),1,1)).rejects.toThrow("disturbing_model_disposed");
    expect(f.run).toHaveBeenCalledOnce();
  });
  it("cleans both tensors on malformed scores or output shape",async()=>{
    for(const f of [fixture([1,1,1]),fixture([0.01,0.01,0.98],[3])]){
      await expect(f.predictor.predict(new Uint8Array(3),1,1)).rejects.toThrow("invalid_disturbing_output");
      expect(f.inputDispose).toHaveBeenCalledOnce();expect(f.outputDispose).toHaveBeenCalledOnce();
      await f.predictor.dispose();
    }
  });
  it("releases the input after inference failure and rejects bad pixels before allocation",async()=>{
    const f=fixture();f.run.mockRejectedValueOnce(new Error("execution_failed"));
    await expect(f.predictor.predict(new Uint8Array(3),1,1)).rejects.toThrow("execution_failed");
    expect(f.inputDispose).toHaveBeenCalledOnce();expect(f.outputDispose).not.toHaveBeenCalled();
    await expect(f.predictor.predict(new Uint8Array(3),2,1)).rejects.toThrow("disturbing_image_dimensions");
    expect(f.run).toHaveBeenCalledOnce();await f.predictor.dispose();
  });
  it("rejects external or ambiguous asset roots before fetching",async()=>{
    const spy=vi.spyOn(globalThis,"fetch");
    try {
      for(const url of ["https://external.invalid/media-classifier/v2/",`${location.origin}/media-classifier/v2/?redirect=1`,`${location.origin}/media-classifier/v1/`])await expect(loadDisturbingModel(url)).rejects.toThrow("disturbing_model_origin");
      expect(spy).not.toHaveBeenCalled();
    } finally {spy.mockRestore();}
  });
});
