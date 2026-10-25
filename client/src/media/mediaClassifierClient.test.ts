import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {MediaClassifierClient} from "./mediaClassifierClient";
import {MEDIA_MODEL} from "./mediaClassifierContract";
class FakePort{
  onmessage:((event:MessageEvent)=>void)|null=null;
  onerror:((event:ErrorEvent)=>unknown)|null=null;
  postMessage=vi.fn();terminate=vi.fn();
  reply(id:number,analysis:unknown=valid){this.onmessage?.({data:{id,analysis}} as MessageEvent);}
}
const valid={model:MEDIA_MODEL.id,sexual:"negative",disturbing:"unknown",sexualProbability:0.01};
const file=()=>new Blob([new Uint8Array([255,216,255])],{type:"image/jpeg"});
let ports:FakePort[],client:MediaClassifierClient;
beforeEach(()=>{ports=[];client=new MediaClassifierClient(()=>{const port=new FakePort();ports.push(port);return port;},"http://local/media-classifier/v1/");});
afterEach(()=>{client.dispose();vi.useRealTimers();});
it("serializes jobs and ignores an unrelated or stale reply",async()=>{
  const first=client.analyze(file()),second=client.analyze(file());
  expect(ports[0].postMessage).toHaveBeenCalledOnce();
  ports[0].reply(999);
  ports[0].reply(1);
  await expect(first).resolves.toEqual(valid);
  expect(ports[0].postMessage).toHaveBeenCalledTimes(2);
  ports[0].reply(1,{...valid,sexual:"positive"});
  ports[0].reply(2);
  await expect(second).resolves.toEqual(valid);
});
it("terminates active cancelled work and starts the next job on a fresh worker",async()=>{
  const controller=new AbortController();
  const first=client.analyze(file(),controller.signal),second=client.analyze(file());
  const rejected=expect(first).rejects.toThrow("media_analysis_cancelled");
  controller.abort();await rejected;
  expect(ports[0].terminate).toHaveBeenCalledOnce();
  expect(ports).toHaveLength(2);
  ports[0].reply(2,{...valid,sexual:"positive"});
  ports[1].reply(2);
  await expect(second).resolves.toEqual(valid);
});
it("bounds queued blobs and rejects unsupported or already-cancelled work",async()=>{
  const pending=Array.from({length:4},()=>client.analyze(file()));
  const settled=Promise.allSettled(pending);
  await expect(client.analyze(file())).rejects.toThrow("media_classifier_busy");
  await expect(client.analyze(new Blob(["x"],{type:"image/svg+xml"}))).rejects.toThrow("media_unsupported");
  const controller=new AbortController();controller.abort();
  await expect(client.analyze(file(),controller.signal)).rejects.toThrow("media_analysis_cancelled");
  client.dispose();expect((await settled).every((entry)=>entry.status==="rejected")).toBe(true);
});
it("accepts animated raster MIME for the bounded local worker",async()=>{
  const pending=client.analyze(new Blob(["gif"],{type:"image/gif"}));
  expect(ports[0].postMessage).toHaveBeenCalledWith(expect.objectContaining({file:expect.any(Blob)}),[]);
  ports[0].reply(1,{...valid,frameSampling:{sampledFrameCount:2,totalFrameCount:8,attachmentCount:1}});
  await expect(pending).resolves.toMatchObject({frameSampling:{sampledFrameCount:2,totalFrameCount:8,attachmentCount:1}});
});
it("transfers one decoded bitmap to the worker for local video-frame classification",async()=>{
  const bitmap={width:1,height:1,close:vi.fn()} as unknown as ImageBitmap;
  const pending=client.analyzeBitmap(bitmap);
  expect(ports[0].postMessage).toHaveBeenCalledWith(expect.objectContaining({bitmap}),[bitmap]);
  ports[0].reply(1,valid);
  await expect(pending).resolves.toEqual(valid);
  expect(bitmap.close).not.toHaveBeenCalled();
});
it("rejects worker-supplied sampling metadata on a single decoded bitmap",async()=>{
  const bitmap={width:1,height:1,close:vi.fn()} as unknown as ImageBitmap;
  const pending=client.analyzeBitmap(bitmap);
  ports[0].reply(1,{...valid,videoSampling:{sampledFrameCount:5,durationSeconds:30,attachmentCount:1}});
  await expect(pending).rejects.toThrow("media_analysis_failed");
  expect(ports[0].terminate).toHaveBeenCalledOnce();
});
it("times out a stalled worker and releases its resources",async()=>{
  vi.useFakeTimers();
  const pending=client.analyze(file());
  const rejected=expect(pending).rejects.toThrow("media_analysis_timeout");
  await vi.advanceTimersByTimeAsync(30000);await rejected;
  expect(ports[0].terminate).toHaveBeenCalledOnce();
});
it("rejects invalid analysis output instead of treating it as safe",async()=>{
  const pending=client.analyze(file());
  ports[0].reply(1,{...valid,disturbing:"negative"});
  await expect(pending).rejects.toThrow("media_analysis_failed");
  expect(ports[0].terminate).toHaveBeenCalledOnce();
});
it("reclaims the loaded worker after an idle interval",async()=>{
  vi.useFakeTimers();
  const pending=client.analyze(file());ports[0].reply(1);await pending;
  await vi.advanceTimersByTimeAsync(10000);
  expect(ports[0].terminate).toHaveBeenCalledOnce();
});
