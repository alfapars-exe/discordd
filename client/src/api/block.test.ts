import {beforeEach,expect,it,vi} from "vitest";
const state=vi.hoisted(()=>({generation:1,client:vi.fn()}));
vi.mock("./client",()=>({apiClient:state.client,getAuthGeneration:()=>state.generation}));
import {blockUser,unblockUser,listBlocked} from "./block";
beforeEach(()=>{state.generation=1;state.client.mockReset();});
it("binds requests to account and cancels retry after authentication generation changes",()=>{
  for(const invoke of [()=>blockUser("target/path",{expectedUserId:"owner",isCurrent:()=>true}),()=>unblockUser("target/path",{expectedUserId:"owner"}),()=>listBlocked({expectedUserId:"owner"})]){
    state.generation=1;invoke();
    const [url,options]=state.client.mock.lastCall!;
    expect(url).toContain("expected_user_id=owner");expect(options.isCurrent()).toBe(true);expect(options.timeoutMs).toBe(15000);
    state.generation++;expect(options.isCurrent()).toBe(false);
  }
  expect(state.client.mock.calls[0][0]).toContain("target%2Fpath");
});
it("honors the caller's account guard before retry",()=>{
  let current=true;blockUser("target",{isCurrent:()=>current});
  const options=state.client.mock.lastCall![1];current=false;expect(options.isCurrent()).toBe(false);
});
