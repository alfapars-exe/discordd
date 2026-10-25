import { beforeEach,describe,expect,it,vi } from "vitest";
const state=vi.hoisted(()=>({generation:1,apiClient:vi.fn(async()=>({success:true,data:{id:"m1"}}))}));
vi.mock("./client",()=>({apiClient:state.apiClient,getAuthGeneration:()=>state.generation}));
import { apiClient } from "./client";
import { addGroupDMMember,leaveGroupDM,getGroupDMMessagesAround,removeGroupDMMember,sendGroupDMMessage,listPinnedGroupDMMessages,pinGroupDMMessage,unpinGroupDMMessage,markGroupDMRead,markGroupDMUnread,setGroupDMMuted } from "./groupDM";

describe("group DM API",()=>{
  it("sends optional membership epoch for read/unread/mute while retaining legacy bodies",()=>{
    markGroupDMRead("g","m",{expectedKeyEpoch:3});expect(vi.mocked(apiClient).mock.lastCall?.[1]?.body).toEqual({message_id:"m",key_epoch:3});
    markGroupDMUnread("g","m",{expectedKeyEpoch:3});expect(vi.mocked(apiClient).mock.lastCall?.[1]?.body).toEqual({message_id:"m",key_epoch:3});
    setGroupDMMuted("g",true,{expectedUserId:"owner",expectedKeyEpoch:3});expect(vi.mocked(apiClient).mock.lastCall?.[1]?.body).toEqual({is_muted:true,key_epoch:3});
    markGroupDMRead("g","m");expect(vi.mocked(apiClient).mock.lastCall?.[1]?.body).toEqual({message_id:"m"});
    markGroupDMUnread("g","m");expect(vi.mocked(apiClient).mock.lastCall?.[1]?.body).toEqual({message_id:"m"});
  });
  it("scopes pin reads and mutations to the account, credential generation and abort signal", () => {
    let current = true;
    const controller = new AbortController();
    const context = { expectedUserId: "owner/id", isCurrent: () => current, signal: controller.signal };
    for (const [invoke, path, method] of [
      [() => listPinnedGroupDMMessages("group/id", context), "/pinned", undefined],
      [() => pinGroupDMMessage("group/id", "message/id", context), "/messages/message%2Fid/pin", "POST"],
      [() => unpinGroupDMMessage("group/id", "message/id", context), "/messages/message%2Fid/pin", "DELETE"],
    ] as const) {
      current = true; state.generation = 1; invoke();
      const [url, options] = vi.mocked(apiClient).mock.lastCall!;
      expect(url).toBe(`/group-dms/group%2Fid${path}?expected_user_id=owner%2Fid`);
      expect(options).toMatchObject({ signal: controller.signal, timeoutMs: 15_000 });
      expect(options?.method).toBe(method);
      expect(options?.isCurrent?.()).toBe(true);
      current = false; expect(options?.isCurrent?.()).toBe(false);
      current = true; state.generation++; expect(options?.isCurrent?.()).toBe(false);
    }
  });
  beforeEach(()=>vi.clearAllMocks());
  it("keeps encrypted attachment bytes in multipart with the membership epoch",async()=>{
    const file=new File([new Uint8Array([1,2,3])],"encrypted.bin",{type:"application/octet-stream"});
    await sendGroupDMMessage("g1",{ciphertext:"[]",sender_device_id:"d1",e2ee_metadata:"{}",key_epoch:7,reply_to_id:"m0",client_request_id:"request-00000001"},[file]);
    const [,options]=vi.mocked(apiClient).mock.calls[0];const body=options?.body as FormData;
    expect(options?.method).toBe("POST");expect(body.get("key_epoch")).toBe("7");expect(body.get("reply_to_id")).toBe("m0");expect(body.getAll("files")).toHaveLength(1);
    expect(body.get("client_request_id")).toBe("request-00000001");
  });

  it("requests a group-scoped around window with caller lifetime and abort signal",()=>{
    const controller=new AbortController();let current=true;const scope={signal:controller.signal,timeoutMs:9000,isCurrent:()=>current};
    getGroupDMMessagesAround("group/id","message/id",50,scope);
    const [url,options]=vi.mocked(apiClient).mock.lastCall!;
    expect(url).toBe("/group-dms/group%2Fid/messages?around=message%2Fid&limit=50");
    expect(options).toMatchObject({signal:controller.signal,timeoutMs:9000});expect(options?.isCurrent?.()).toBe(true);
    current=false;expect(options?.isCurrent?.()).toBe(false);
  });

  it("scopes membership mutations to the expected account and request lifetime",()=>{
    let current=true;
    const context={expectedUserId:"user/id &?",isCurrent:()=>current};
    const requests=[
      {invoke:()=>addGroupDMMember("group/id","member/id",context),url:"/group-dms/group%2Fid/members?expected_user_id=user%2Fid%20%26%3F",method:"POST"},
      {invoke:()=>removeGroupDMMember("group/id","member/id",context),url:"/group-dms/group%2Fid/members/member%2Fid?expected_user_id=user%2Fid%20%26%3F",method:"DELETE"},
      {invoke:()=>leaveGroupDM("group/id",context),url:"/group-dms/group%2Fid/leave?expected_user_id=user%2Fid%20%26%3F",method:"POST"},
    ];

    for(const request of requests){
      current=true;state.generation=1;request.invoke();
      const [url,options]=vi.mocked(apiClient).mock.lastCall!;
      expect(url).toBe(request.url);expect(options?.method).toBe(request.method);expect(options?.timeoutMs).toBe(15_000);expect(options?.isCurrent?.()).toBe(true);
      current=false;expect(options?.isCurrent?.()).toBe(false);
      current=true;state.generation++;expect(options?.isCurrent?.()).toBe(false);
    }
  });
});
