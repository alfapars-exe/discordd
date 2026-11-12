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

it("keeps an established call when a busy reply arrives for a failed attempt", () => {
  const active = { ...call(), status: "active" as const };
  useP2PCallStore.setState({ activeCall: active });
  useP2PCallStore.getState().handleCallBusy({ receiver_id: active.receiver_id });
  expect(useP2PCallStore.getState().activeCall).toBe(active);
  expect(fixture.toast).not.toHaveBeenCalled();
});

it("shows a busy reply to an idle caller", () => {
  useP2PCallStore.setState({ activeCall: null });
  useP2PCallStore.getState().handleCallBusy({ receiver_id: "receiver" });
  expect(fixture.toast).toHaveBeenCalledExactlyOnceWith("warning", "common:userBusy");
});

it("accepts only the currently displayed ringing call", () => {
  const send = vi.fn();
  useP2PCallStore.setState({ incomingCall: call("current"), _sendWS: send });
  useP2PCallStore.getState().acceptCall("stale");
  useP2PCallStore.getState().acceptCall("current");
  expect(send).toHaveBeenCalledExactlyOnceWith("p2p_call_accept", { call_id: "current" });
});

it("lets the caller cancel a ringing call without an incoming overlay", () => {
  const send = vi.fn();
  useP2PCallStore.setState({ _sendWS: send });
  useP2PCallStore.getState().declineCall("call");
  expect(send).toHaveBeenCalledExactlyOnceWith("p2p_call_decline", { call_id: "call" });
  expect(useP2PCallStore.getState().activeCall).toBeNull();
});

it("declining an incoming overlay preserves the other call", () => {
  const active = { ...call(), status: "active" as const };
  const send = vi.fn();
  useP2PCallStore.setState({ activeCall: active, incomingCall: call("incoming"), _sendWS: send });
  useP2PCallStore.getState().declineCall("incoming");
  expect(send).toHaveBeenCalledExactlyOnceWith("p2p_call_decline", { call_id: "incoming" });
  expect(useP2PCallStore.getState().incomingCall).toBeNull();
  expect(useP2PCallStore.getState().activeCall).toBe(active);
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
