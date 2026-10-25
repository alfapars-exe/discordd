import {act,renderHook,waitFor} from "@testing-library/react";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {useLocalMediaAnalysis,type LocalMediaInput} from "./useLocalMediaAnalysis";
import {useAuthStore} from "../stores/authStore";
import {useE2EEStore} from "../stores/e2eeStore";
import * as classifier from "../media/mediaClassifierClient";
import * as encryption from "../crypto/fileEncryption";
import {MEDIA_MODEL,type MediaAnalysis} from "../media/mediaClassifierContract";
import {clearTokens} from "../api/client";
vi.mock("../media/mediaClassifierClient",()=>({analyzeMediaLocally:vi.fn()}));
const analysis:MediaAnalysis={model:MEDIA_MODEL.id,sexual:"negative",disturbing:"unknown",sexualProbability:0.01};
const inputs:LocalMediaInput[]=[{url:"/uploads/image.jpg",mimeType:"image/jpeg",size:3}];
const analyze=vi.mocked(classifier.analyzeMediaLocally);
const settled=vi.fn();
beforeEach(()=>{
  vi.clearAllMocks();
  useAuthStore.setState({user:{id:"owner"} as never});
  useE2EEStore.setState({localDeviceId:"device"});
  vi.stubGlobal("fetch",vi.fn(async()=>new Response(new Uint8Array([255,216,255]))));
  analyze.mockReset().mockResolvedValue(analysis);
});
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();});
it("downloads only a bounded local upload and passes a blob, not credentials/keys, to the worker",async()=>{
  const hook=renderHook(()=>useLocalMediaAnalysis(inputs,true,settled));
  await waitFor(()=>expect(hook.result.current.status).toBe("ready"));
  expect(fetch).toHaveBeenCalledWith(expect.stringMatching(/\/uploads\/image.jpg$/),expect.objectContaining({credentials:"include",redirect:"error",signal:expect.any(AbortSignal)}));
  expect(analyze).toHaveBeenCalledWith(expect.any(Blob),expect.any(AbortSignal));
  expect(analyze.mock.calls[0][0].type).toBe("image/jpeg");
  expect(hook.result.current.analysis).toEqual(analysis);
});
it("decrypts encrypted media on device before submitting the file",async()=>{
  const meta={key:"private-key",iv:"private-iv",digest:"digest",filename:"private-name",mimeType:"image/jpeg",originalSize:3};
  const file=new File([new Uint8Array([255,216,255])],"private-name",{type:"image/jpeg"});
  const decrypt=vi.spyOn(encryption,"decryptFile").mockResolvedValue(file);
  const hook=renderHook(()=>useLocalMediaAnalysis([{...inputs[0],fileMeta:meta}],true,settled));
  await waitFor(()=>expect(hook.result.current.status).toBe("ready"));
  expect(decrypt).toHaveBeenCalledWith(expect.stringMatching(/\/uploads\/image.jpg$/),meta,expect.objectContaining({maxBytes:12*1024*1024+16,signal:expect.any(AbortSignal)}));
  expect(analyze.mock.calls[0]).toEqual([file,expect.any(AbortSignal)]);
  expect(fetch).not.toHaveBeenCalled();
});
it("does not decrypt stale encrypted descriptors after device identity is cleared",async()=>{
  useE2EEStore.setState({localDeviceId:null});
  const decrypt=vi.spyOn(encryption,"decryptFile");
  const meta={key:"private-key",iv:"private-iv",digest:"digest",filename:"private-name",mimeType:"image/jpeg",originalSize:3};
  const hook=renderHook(()=>useLocalMediaAnalysis([{...inputs[0],fileMeta:meta}],true,settled));
  await waitFor(()=>expect(hook.result.current.status).toBe("error"));
  expect(decrypt).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();expect(analyze).not.toHaveBeenCalled();
});
it.each(["https://third-party.example/image.jpg","/api/users/me","data:image/jpeg;base64,abcd"])("does not automatically fetch an untrusted source %s",async(url)=>{
  const hook=renderHook(()=>useLocalMediaAnalysis([{...inputs[0],url}],true,settled));
  await waitFor(()=>expect(hook.result.current.status).toBe("error"));
  expect(fetch).not.toHaveBeenCalled();expect(analyze).not.toHaveBeenCalled();
});
it("keeps unsupported media and excessive attachment sets unknown without downloading",async()=>{
  const hook=renderHook(({sources})=>useLocalMediaAnalysis(sources,true,settled),{initialProps:{sources:[{...inputs[0],mimeType:"image/svg+xml"}]}});
  await waitFor(()=>expect(hook.result.current.status).toBe("error"));
  hook.rerender({sources:Array.from({length:5},()=>inputs[0])});
  await waitFor(()=>expect(hook.result.current.status).toBe("error"));
  expect(fetch).not.toHaveBeenCalled();
});
it("allows GIF through the local-only pipeline for bounded frame analysis",async()=>{
  const hook=renderHook(()=>useLocalMediaAnalysis([{...inputs[0],mimeType:"image/gif"}],true,settled));
  await waitFor(()=>expect(hook.result.current.status).toBe("ready"));
  expect(fetch).toHaveBeenCalledOnce();expect(analyze).toHaveBeenCalledOnce();
  expect(analyze.mock.calls[0][0].type).toBe("image/gif");
});
it("aborts replaced sources and cannot apply their late analysis",async()=>{
  let finish!:(value:MediaAnalysis)=>void;
  analyze.mockReturnValueOnce(new Promise((resolve)=>{finish=resolve;}));
  const hook=renderHook(({sources})=>useLocalMediaAnalysis(sources,true,settled),{initialProps:{sources:inputs}});
  await waitFor(()=>expect(analyze).toHaveBeenCalledOnce());
  const oldSignal=analyze.mock.calls[0][1];
  hook.rerender({sources:[{...inputs[0],url:"/uploads/new.jpg"}]});
  await waitFor(()=>expect(hook.result.current.status).toBe("ready"));
  expect(oldSignal.aborted).toBe(true);
  await act(async()=>finish({...analysis,sexual:"positive",sexualProbability:0.95}));
  expect(hook.result.current.analysis?.sexual).toBe("negative");
});
it("rejects a pending analysis after an encryption-device reset",async()=>{
  let finish!:(value:MediaAnalysis)=>void;
  analyze.mockReturnValueOnce(new Promise((resolve)=>{finish=resolve;}));
  const hook=renderHook(()=>useLocalMediaAnalysis(inputs,true,settled));
  await waitFor(()=>expect(analyze).toHaveBeenCalledOnce());
  const signal=analyze.mock.calls[0][1];
  act(()=>useE2EEStore.setState({localDeviceId:null}));
  await act(async()=>finish({...analysis,sexual:"positive",sexualProbability:0.95}));
  expect(signal.aborted).toBe(true);
  expect(hook.result.current.analysis?.sexual).not.toBe("positive");
});
it("restarts for same-account reauthentication and rejects the old session's result",async()=>{
  let finish!:(value:MediaAnalysis)=>void;
  analyze.mockReturnValueOnce(new Promise((resolve)=>{finish=resolve;}));
  const hook=renderHook(()=>useLocalMediaAnalysis(inputs,true,settled));
  await waitFor(()=>expect(analyze).toHaveBeenCalledOnce());
  const signal=analyze.mock.calls[0][1];
  act(()=>{clearTokens();useAuthStore.setState({user:{id:"owner"} as never});});
  await waitFor(()=>expect(hook.result.current.status).toBe("ready"));
  expect(analyze).toHaveBeenCalledTimes(2);expect(signal.aborted).toBe(true);
  await act(async()=>finish({...analysis,sexual:"positive",sexualProbability:0.95}));
  expect(hook.result.current.analysis?.sexual).toBe("negative");
});
