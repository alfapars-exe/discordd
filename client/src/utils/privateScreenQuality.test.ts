import {expect,it,vi} from "vitest";
import {privateScreenResolution} from "./privateScreenQuality";
it("resolves saved native preferences without inventing browser refresh rate",()=>{expect(privateScreenResolution({screenShareQuality:"native",screenShareFps:-1})).toEqual({width:1920,height:1080,frameRate:60});expect(privateScreenResolution({screenShareQuality:"native",screenShareFps:-1},{width:3840,height:2160,refreshRate:144})).toEqual({width:3840,height:2160,frameRate:144});});
it("does not apply encoding changes to a replacement publisher after constraints await",async()=>{
 const {updatePrivateScreenQuality}=await import("./privateScreenQuality");let finish!:()=>void;const raw={readyState:"live",applyConstraints:()=>new Promise<void>(done=>{finish=done;})} as unknown as MediaStreamTrack;const sender={track:raw,getParameters:()=>({encodings:[{}]}),setParameters:vi.fn()};const update=updatePrivateScreenQuality(raw,sender as unknown as RTCRtpSender,{screenShareQuality:"1440p",screenShareFps:120},()=>true);sender.track={} as MediaStreamTrack;finish();expect(await update).toBe(false);expect(sender.setParameters).not.toHaveBeenCalled();
});
