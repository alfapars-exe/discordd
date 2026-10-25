import {afterEach,beforeEach,expect,it,vi} from "vitest";
import type {P2PCall} from "../types";
const fixture=vi.hoisted(()=>({userId:"caller",toast:vi.fn()}));
vi.mock("./authStore",()=>({useAuthStore:{getState:()=>({user:{id:fixture.userId}})}}));
vi.mock("./voiceStore",()=>({useVoiceStore:{getState:()=>({}),subscribe:()=>()=>{}}}));
vi.mock("./toastStore",()=>({useToastStore:{getState:()=>({addToast:fixture.toast})}}));
vi.mock("../i18n",()=>({default:{t:(key:string)=>key}}));
import {useP2PCallStore} from "./p2pCallStore";
const call=(id="call"):P2PCall=>({id,caller_id:"caller",caller_username:"caller",caller_display_name:null,caller_avatar:null,receiver_id:"receiver",receiver_username:"receiver",receiver_display_name:null,receiver_avatar:null,call_type:"voice",status:"ringing",created_at:"2026-10-24T00:00:00Z"});
beforeEach(()=>{fixture.userId="caller";fixture.toast.mockClear();useP2PCallStore.setState({activeCall:call(),incomingCall:null});});
afterEach(()=>useP2PCallStore.getState().cleanup());
it("handles an authoritative no-answer once without sending a competing local hangup",()=>{
  const send=vi.fn();useP2PCallStore.setState({_sendWS:send});
  useP2PCallStore.getState().handleCallEnd({call_id:"call",reason:"no_answer"});
  useP2PCallStore.getState().handleCallEnd({call_id:"call",reason:"no_answer"});
  expect(useP2PCallStore.getState().activeCall).toBeNull();
  expect(fixture.toast).toHaveBeenCalledExactlyOnceWith("info","common:callNoAnswer");
  expect(send).not.toHaveBeenCalled();
});
it("ignores a late end event for an older call",()=>{
  useP2PCallStore.getState().handleCallEnd({call_id:"old-call",reason:"no_answer"});
  expect(useP2PCallStore.getState().activeCall?.id).toBe("call");
  expect(fixture.toast).not.toHaveBeenCalled();
});
it("clears only a matching incoming overlay when another call is active",()=>{
  useP2PCallStore.setState({incomingCall:call("incoming")});
  useP2PCallStore.getState().handleCallEnd({call_id:"incoming",reason:"no_answer"});
  expect(useP2PCallStore.getState().activeCall?.id).toBe("call");
  expect(useP2PCallStore.getState().incomingCall).toBeNull();
});
it("does not show the caller-only no-answer toast to the receiver or an accepted call",()=>{
  fixture.userId="receiver";
  useP2PCallStore.getState().handleCallEnd({call_id:"call",reason:"no_answer"});
  expect(fixture.toast).not.toHaveBeenCalled();
  fixture.userId="caller";useP2PCallStore.setState({activeCall:{...call(),status:"active"}});
  useP2PCallStore.getState().handleCallEnd({call_id:"call",reason:"no_answer"});
  expect(fixture.toast).not.toHaveBeenCalled();
});
