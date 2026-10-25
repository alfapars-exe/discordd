import {expect,it,vi} from "vitest";
const state=vi.hoisted(()=>({generation:1,client:vi.fn()}));
vi.mock("./client",()=>({apiClient:state.client,getAuthGeneration:()=>state.generation}));
import * as api from "./friends";
it("binds all friendship APIs to original identity and generation",()=>{
  const context={expectedUserId:"owner",isCurrent:()=>true};
  for(const invoke of [()=>api.listFriends(context),()=>api.listRequests(context),()=>api.sendRequest("peer",context),()=>api.acceptRequest("id/path",context),()=>api.declineRequest("id/path",context),()=>api.removeFriend("id/path",context)]){
    state.generation=1;invoke();const [url,options]=state.client.mock.lastCall!;
    expect(url).toContain("expected_user_id=owner");expect(options.timeoutMs).toBe(15000);expect(options.isCurrent()).toBe(true);
    state.generation++;expect(options.isCurrent()).toBe(false);
  }
  expect(state.client.mock.calls[3][0]).toContain("id%2Fpath");
});
