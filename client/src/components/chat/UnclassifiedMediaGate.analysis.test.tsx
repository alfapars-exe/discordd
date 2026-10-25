import {act,render,screen,waitFor} from "@testing-library/react";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import UnclassifiedMediaGate from "./UnclassifiedMediaGate";
import {useAuthStore} from "../../stores/authStore";
import {usePreferencesStore} from "../../stores/preferencesStore";
import {useE2EEStore} from "../../stores/e2eeStore";
import {analyzeMediaLocally} from "../../media/mediaClassifierClient";
import {getMediaLabel} from "../../api/mediaLabels";
import {MEDIA_MODEL,type MediaAnalysis} from "../../media/mediaClassifierContract";
import {clearTokens} from "../../api/client";
import {interpretDisturbingProbabilities} from "../../media/disturbingModelContract";
vi.mock("react-i18next",()=>({useTranslation:()=>({t:(key:string)=>key}),initReactI18next:{type:"3rdParty",init:()=>{}}}));
vi.mock("../../media/mediaClassifierClient",()=>({analyzeMediaLocally:vi.fn()}));
vi.mock("../../api/mediaLabels",()=>({getMediaLabel:vi.fn(),setMediaLabel:vi.fn(),deleteMediaLabel:vi.fn()}));
const negative:MediaAnalysis={model:MEDIA_MODEL.id,sexual:"negative",disturbing:"unknown",sexualProbability:0.01};
const gate=()=> <UnclassifiedMediaGate authorId="other" identity="image" messageId="message" sourceKind="dm" sourceChannelId="private" privateConversation mediaInputs={[{url:"/uploads/image.jpg",mimeType:"image/jpeg"}]}><span>filtered image</span></UnclassifiedMediaGate>;
beforeEach(()=>{
  vi.clearAllMocks();
  useAuthStore.setState({user:{id:"owner"} as never});
  useE2EEStore.setState({localDeviceId:"device"});
  usePreferencesStore.setState({data:{privacy:{sensitiveMedia:{otherDMs:"block"},disturbingMedia:{otherDMs:"show"}}}});
  vi.mocked(getMediaLabel).mockReset().mockResolvedValue({success:true,data:{annotation:null}});
  vi.mocked(analyzeMediaLocally).mockReset().mockResolvedValue(negative);
  vi.stubGlobal("fetch",vi.fn(async()=>new Response(new Uint8Array([255,216,255]))));
});
afterEach(()=>vi.unstubAllGlobals());
it("shows media only after both locally analyzed categories permit it",async()=>{
  usePreferencesStore.setState({data:{privacy:{sensitiveMedia:{otherDMs:"block"},disturbingMedia:{otherDMs:"block"}}}});
  const detail=interpretDisturbingProbabilities([0.01,0.01,0.98]);
  vi.mocked(analyzeMediaLocally).mockResolvedValueOnce({...negative,disturbing:detail.verdict,disturbingAnalysis:detail});
  render(gate());
  expect(screen.queryByText("filtered image")).not.toBeInTheDocument();
  await screen.findByText("mediaAnalysisLocal");
  expect(screen.getByText("filtered image")).toBeInTheDocument();
});
it("describes sampled animation frames without presenting unseen frames as safe",async()=>{
  vi.mocked(analyzeMediaLocally).mockResolvedValueOnce({...negative,sexual:"uncertain",frameSampling:{sampledFrameCount:5,totalFrameCount:12,attachmentCount:1}});
  render(gate());
  await screen.findByText("mediaAnalysisFramesSampled");
  expect(screen.queryByText("filtered image")).not.toBeInTheDocument();
  expect(screen.queryByText("mediaAnalysisLocal")).not.toBeInTheDocument();
});
it("shows both sampling warnings for mixed animations and videos",async()=>{
  vi.mocked(analyzeMediaLocally).mockResolvedValueOnce({...negative,sexual:"uncertain",frameSampling:{sampledFrameCount:5,totalFrameCount:12,attachmentCount:1},videoSampling:{sampledFrameCount:5,durationSeconds:12.5,attachmentCount:1}});
  render(gate());
  await screen.findByText("mediaAnalysisVideoSampled");
  expect(screen.getByText("mediaAnalysisFramesSampled")).toBeInTheDocument();
  expect(screen.queryByText("filtered image")).not.toBeInTheDocument();
  expect(screen.queryByText("mediaAnalysisLocal")).not.toBeInTheDocument();
});
it("does not mount hidden media until the complete local analysis permits it",async()=>{
  let finish!:(value:MediaAnalysis)=>void;
  vi.mocked(analyzeMediaLocally).mockReturnValueOnce(new Promise((resolve)=>{finish=resolve;}));
  render(gate());
  expect(screen.queryByText("filtered image")).not.toBeInTheDocument();
  await waitFor(()=>expect(analyzeMediaLocally).toHaveBeenCalledOnce());
  await act(async()=>finish(negative));
  await screen.findByText("filtered image");
  expect(screen.getByText("mediaAnalysisPartial")).toBeInTheDocument();
});
it("keeps disturbing-content protection even when sexual analysis is negative",async()=>{
  usePreferencesStore.setState({data:{privacy:{sensitiveMedia:{otherDMs:"block"},disturbingMedia:{otherDMs:"block"}}}});
  vi.mocked(analyzeMediaLocally).mockResolvedValueOnce(negative);
  render(gate());
  await screen.findByText("mediaAnalysisPartial");
  expect(screen.queryByText("filtered image")).not.toBeInTheDocument();
});
it("keeps failed and positive analyses protected",async()=>{
  vi.mocked(analyzeMediaLocally).mockRejectedValueOnce(new Error("unavailable"));
  const rendered=render(gate());
  await screen.findByText("mediaAnalysisUnknown");
  expect(screen.queryByText("filtered image")).not.toBeInTheDocument();
  rendered.unmount();
  vi.mocked(analyzeMediaLocally).mockResolvedValueOnce({...negative,sexual:"positive",sexualProbability:0.95});
  render(gate());
  await screen.findByText("mediaAnalysisPartial");
  expect(screen.queryByText("filtered image")).not.toBeInTheDocument();
});
it("does not let automatic analysis override an unavailable personal annotation",async()=>{
  vi.mocked(getMediaLabel).mockResolvedValueOnce({success:false,error:"offline"});
  vi.mocked(analyzeMediaLocally).mockResolvedValueOnce(negative);
  render(gate());
  await screen.findByText("mediaAnnotationError");
  expect(screen.queryByText("filtered image")).not.toBeInTheDocument();
  expect(analyzeMediaLocally).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});
it("reloads an old revealing annotation when the same account signs in again",async()=>{
  vi.mocked(getMediaLabel).mockImplementationOnce(async(reference)=>({success:true,data:{annotation:{...reference,label:"ordinary",version:"legacy"}}}));
  vi.mocked(analyzeMediaLocally).mockResolvedValueOnce({...negative,sexual:"positive",sexualProbability:0.95});
  render(gate());await screen.findByText("filtered image");
  act(()=>{clearTokens();useAuthStore.setState({user:{id:"owner"} as never});});
  expect(screen.queryByText("filtered image")).not.toBeInTheDocument();
  await screen.findByText("mediaAnalysisPartial");
  expect(getMediaLabel).toHaveBeenCalledTimes(2);
  expect(screen.queryByText("filtered image")).not.toBeInTheDocument();
});
