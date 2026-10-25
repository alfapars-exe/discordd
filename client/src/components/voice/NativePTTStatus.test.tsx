import {act,fireEvent,render,renderHook,screen}from "@testing-library/react";
import {afterEach,beforeEach,expect,it,vi}from "vitest";
import {create}from "zustand";
import i18n from "../../i18n";
import NativePTTStatus from "./NativePTTStatus";
import {usePushToTalk}from "../../hooks/usePushToTalk";
import {useVoiceStore}from "../../stores/voiceStore";
import {publishAuthGenerationChange,publishAuthOwnerChange}from "../../api/authSessionEvents";
vi.mock("../../utils/constants",()=>({isElectron:()=>true}));
vi.mock("../../stores/voiceStore",()=>({useVoiceStore:create(()=>({inputMode:"push_to_talk",pttKey:"Space",currentVoiceChannelId:"voice",isMuted:false,isServerMuted:false,isDeafened:false}))}));
let acquire:ReturnType<typeof vi.fn>;
beforeEach(async()=>{await i18n.changeLanguage("en");publishAuthOwnerChange("owner");publishAuthGenerationChange(1);useVoiceStore.setState({currentVoiceChannelId:"voice"});acquire=vi.fn().mockResolvedValueOnce(null).mockResolvedValue("ready");window.electronAPI={acquirePTTLease:acquire,releasePTTLease:vi.fn(async()=>{}),onPTTLeaseSignal:()=>()=>{}}as unknown as Window["electronAPI"];});
afterEach(()=>{window.electronAPI=undefined;});
it("renders translated guild failure and explicit Retry reacquires without enabling capture",async()=>{
 const microphone=vi.fn();function View(){const ptt=usePushToTalk({setMicEnabled:microphone});return <NativePTTStatus unavailable={ptt.nativeUnavailable} retry={ptt.retryNative}/>;}
 const view=render(<View/>);expect(await screen.findByRole("alert")).toHaveTextContent("Global push-to-talk could not be registered. Retry before speaking.");expect(microphone).not.toHaveBeenCalledWith(true);fireEvent.click(screen.getByRole("button",{name:i18n.t("voice:p2pAudioRetry")}));await act(async()=>{});expect(acquire).toHaveBeenCalledTimes(2);expect(screen.queryByRole("alert")).toBeNull();expect(microphone).not.toHaveBeenCalledWith(true);view.unmount();
});
it.each(["channel","auth"])("retained guild Retry cannot alter a replacement %s source",async(reason)=>{
 const microphone=vi.fn();const view=renderHook(()=>usePushToTalk({setMicEnabled:microphone}));await act(async()=>{});expect(view.result.current.nativeUnavailable).toBe(true);const old=view.result.current.retryNative;
 act(()=>{if(reason==="channel")useVoiceStore.setState({currentVoiceChannelId:"replacement"});else publishAuthGenerationChange(2);});await act(async()=>{});const calls=acquire.mock.calls.length;act(()=>old());await act(async()=>{});expect(acquire).toHaveBeenCalledTimes(calls);expect(microphone).not.toHaveBeenCalledWith(true);view.unmount();
});
