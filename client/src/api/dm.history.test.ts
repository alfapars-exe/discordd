import {describe, expect, it, vi} from "vitest";
vi.mock("./client", () => ({apiClient:vi.fn()}));
import {apiClient} from "./client";
import {deleteDMMessage, getDMMessages, getDMMessagesAfter, getDMMessagesAround, markDMRead} from "./dm";

describe("DM history request lifetime", () => {
  it("forwards read-cursor context and timeout with the exact message anchor", () => {
    const options = { isCurrent: () => true, timeoutMs: 15000 };
    markDMRead("channel", "latest", options);
    expect(apiClient).toHaveBeenLastCalledWith("/dms/channel/read", { ...options, method: "POST", body: { message_id: "latest" } });
  });
  it("forwards deletion context and timeout without changing the DELETE method",()=>{
    const options={isCurrent:()=>true,timeoutMs:15000};deleteDMMessage("message",options);
    expect(apiClient).toHaveBeenLastCalledWith("/dms/messages/message",{...options,method:"DELETE"});
  });
  it.each([
    [getDMMessages, "before"],
    [getDMMessagesAfter, "after"],
    [getDMMessagesAround, "around"],
  ] as const)("forwards cancellation and timeout for %s", (read, parameter) => {
    const controller = new AbortController();
    const options = {signal:controller.signal, isCurrent:() => true, timeoutMs:15000};
    read("channel", "message", 50, options);
    expect(apiClient).toHaveBeenLastCalledWith(`/dms/channel/messages?${parameter}=message&limit=50`, options);
  });
});
