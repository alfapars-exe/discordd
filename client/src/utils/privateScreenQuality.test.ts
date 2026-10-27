import {expect,it,vi} from "vitest";
import {privateScreenResolution} from "./privateScreenQuality";
it("resolves saved native preferences without inventing browser refresh rate",()=>{expect(privateScreenResolution({screenShareQuality:"native",screenShareFps:-1})).toEqual({width:1920,height:1080,frameRate:60});expect(privateScreenResolution({screenShareQuality:"native",screenShareFps:-1},{width:3840,height:2160,refreshRate:144})).toEqual({width:3840,height:2160,frameRate:144});});
it("does not apply encoding changes to a replacement publisher after constraints await",async()=>{
 const {updatePrivateScreenQuality}=await import("./privateScreenQuality");let finish!:()=>void;const raw={readyState:"live",applyConstraints:()=>new Promise<void>(done=>{finish=done;})} as unknown as MediaStreamTrack;const sender={track:raw,getParameters:()=>({encodings:[{}]}),setParameters:vi.fn()};const update=updatePrivateScreenQuality(raw,sender as unknown as RTCRtpSender,{screenShareQuality:"1440p",screenShareFps:120},()=>true);await vi.waitFor(()=>expect(finish).toBeTypeOf("function"));sender.track={} as MediaStreamTrack;finish();expect(await update).toBe(false);expect(sender.setParameters).not.toHaveBeenCalled();
});

it("shares detail-mode degradation even when low latency chooses H264",async()=>{
 const {updatePrivateScreenQuality}=await import("./privateScreenQuality");const raw={readyState:"live",contentHint:"motion",applyConstraints:vi.fn().mockResolvedValue(undefined)} as unknown as MediaStreamTrack;const sender={track:raw,getParameters:()=>({encodings:[{}]}),setParameters:vi.fn().mockResolvedValue(undefined)};
 expect(await updatePrivateScreenQuality(raw,sender as unknown as RTCRtpSender,{screenShareQuality:"1080p",screenShareFps:60,screenShareLowLatency:true,screenShareMode:"detail"},()=>true)).toBe(true);
 expect(raw.contentHint).toBe("detail");expect(sender.setParameters).toHaveBeenLastCalledWith(expect.objectContaining({degradationPreference:"maintain-resolution"}));
});
