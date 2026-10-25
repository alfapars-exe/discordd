import {expect,it,vi} from "vitest";
import {readExactMediaAsset} from "./mediaModelAssets";
it("reads an exact static model asset and rejects truncated/error responses",async()=>{
  const result=await readExactMediaAsset(new Response(new Uint8Array([1,2,3])),3);
  expect([...new Uint8Array(result)]).toEqual([1,2,3]);
  await expect(readExactMediaAsset(new Response(new Uint8Array([1,2])),3)).rejects.toThrow("media_model_integrity");
  await expect(readExactMediaAsset(new Response(null,{status:404}),3)).rejects.toThrow("media_model_unavailable");
});
it("cancels a body that exceeds its pinned size instead of buffering it",async()=>{
  const cancel=vi.fn();
  const stream=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new Uint8Array(8));},cancel});
  await expect(readExactMediaAsset(new Response(stream),3)).rejects.toThrow("media_model_integrity");
  expect(cancel).toHaveBeenCalledOnce();
});
