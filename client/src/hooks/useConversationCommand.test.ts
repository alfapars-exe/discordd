import { renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { useConversationCommand } from "./useConversationCommand";
import { CONVERSATION_COMMAND_EVENT, dispatchConversationCommand } from "../utils/conversationCommands";
const state = vi.hoisted(() => ({ destination: { type:"text",channelId:"c",serverInfo:{serverId:"a"} } }));
vi.mock("../stores/uiStore", () => ({ useUIStore:{getState:()=>state} }));
vi.mock("../stores/toastStore", () => ({ useToastStore:{getState:()=>({addToast:vi.fn()})} }));
vi.mock("../i18n", () => ({default:{t:(key:string)=>key}}));
beforeEach(() => { state.destination = {type:"text",channelId:"c",serverInfo:{serverId:"a"}}; });
it("delivers only to the active conversation including its server identity", () => {
  const a = vi.fn(()=>true), b = vi.fn(()=>true);
  renderHook(()=>useConversationCommand({kind:"channel",id:"c",serverId:"a"},a));
  renderHook(()=>useConversationCommand({kind:"channel",id:"c",serverId:"b"},b));
  expect(dispatchConversationCommand("pins")).toBe(true);
  expect(a).toHaveBeenCalledWith("pins"); expect(b).not.toHaveBeenCalled();
  state.destination.serverInfo.serverId = "b";
  expect(dispatchConversationCommand("search")).toBe(true);
  expect(b).toHaveBeenCalledWith("search"); expect(a).toHaveBeenCalledOnce();
});
it("rejects malformed commands and unhandled or unmounted views", () => {
  const handle = vi.fn(()=>false);
  const {unmount}=renderHook(()=>useConversationCommand({kind:"channel",id:"c",serverId:"a"},handle));
  window.dispatchEvent(new CustomEvent(CONVERSATION_COMMAND_EVENT,{detail:{command:"delete-everything",target:{kind:"channel",id:"c",serverId:"a"}}}));
  expect(handle).not.toHaveBeenCalled();
  expect(dispatchConversationCommand("members")).toBe(false);
  unmount(); handle.mockClear();
  expect(dispatchConversationCommand("pins")).toBe(false); expect(handle).not.toHaveBeenCalled();
});
it("does not toggle the underlying chat while a modal is open", () => {
  const handle=vi.fn(()=>true);
  renderHook(()=>useConversationCommand({kind:"channel",id:"c",serverId:"a"},handle));
  const modal=document.createElement("div");modal.className="settings-overlay";document.body.append(modal);
  expect(dispatchConversationCommand("search")).toBe(false);expect(handle).not.toHaveBeenCalled();
  modal.remove();
});
