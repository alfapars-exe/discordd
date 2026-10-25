import {expect,it,vi} from "vitest";
vi.mock("./client",()=>({apiClient:vi.fn()}));
import {apiClient} from "./client";
import {getMediaLabel,setMediaLabel,deleteMediaLabel} from "./mediaLabels";
const reference={source_kind:"dm" as const,channel_id:"private",message_id:"message",revision:"original",fingerprint:"a".repeat(64)};
it("forwards reference-only GET with context guard and a bounded timeout",()=>{
  const options={isCurrent:()=>true,signal:new AbortController().signal};
  getMediaLabel({...reference,channel_id:"private & other"},options);
  const [path,request]=vi.mocked(apiClient).mock.calls.at(-1)!;
  expect(new URL(String(path),"http://local").searchParams.get("channel_id")).toBe("private & other");
  expect(request).toMatchObject({...options,timeoutMs:15000});
});
it("never forwards extra decrypted/media/account fields to annotation mutations",()=>{
  const unsafe={...reference,content:"never upload",media:new Uint8Array([1,2]),user_id:"forged"};
  setMediaLabel(unsafe,"sexual",{expectedVersion:""});
  expect(apiClient).toHaveBeenLastCalledWith("/users/me/media-label",expect.objectContaining({method:"PUT",body:{...reference,label:"sexual",expected_version:""}}));
  deleteMediaLabel(unsafe,{expectedVersion:"legacy"});
  expect(apiClient).toHaveBeenLastCalledWith("/users/me/media-label",expect.objectContaining({method:"DELETE",body:{...reference,expected_version:"legacy"}}));
});
