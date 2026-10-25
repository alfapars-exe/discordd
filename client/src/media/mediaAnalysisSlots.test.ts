import {expect,it} from "vitest";
import {acquireMediaAnalysisSlot} from "./mediaAnalysisSlots";
it("bounds active pipelines and queued descriptors; cancellation and repeated release do not leak permits",async()=>{
  const controller=new AbortController();
  const active=await Promise.all(Array.from({length:4},()=>acquireMediaAnalysisSlot(controller.signal)));
  const queued=Array.from({length:12},()=>acquireMediaAnalysisSlot(controller.signal));
  const all=Promise.allSettled(queued);
  await expect(acquireMediaAnalysisSlot(new AbortController().signal)).rejects.toThrow("media_analysis_limit");
  controller.abort();
  expect((await all).every((result)=>result.status==="rejected")).toBe(true);
  for(const release of active){release();release();}
  const next=await acquireMediaAnalysisSlot(new AbortController().signal);next();
});
it("hands a released permit to a queued pipeline",async()=>{
  const active=await Promise.all(Array.from({length:4},()=>acquireMediaAnalysisSlot(new AbortController().signal)));
  const pending=acquireMediaAnalysisSlot(new AbortController().signal);
  active[0]();const next=await pending;next();
  active.slice(1).forEach((release)=>release());
});
