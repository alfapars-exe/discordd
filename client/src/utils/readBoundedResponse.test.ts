import {expect,it,vi} from "vitest";
import {readBoundedResponse} from "./readBoundedResponse";
it("bounds an untrusted media response regardless of reported content length",async()=>{
  await expect(readBoundedResponse(new Response(new Uint8Array(4),{headers:{"content-length":"1"}}),3)).rejects.toThrow("media_too_large");
  expect(new Uint8Array(await readBoundedResponse(new Response(new Uint8Array([1,2])),3))).toEqual(new Uint8Array([1,2]));
});
it("cancels a blocked stream when its source is aborted",async()=>{
  const controller=new AbortController(),cancel=vi.fn();
  const response=new Response(new ReadableStream({cancel}));
  const pending=readBoundedResponse(response,8,controller.signal);
  controller.abort();
  await expect(pending).rejects.toThrow("media_analysis_cancelled");
  expect(cancel).toHaveBeenCalledOnce();
});
