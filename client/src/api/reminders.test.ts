import {expect,it,vi} from "vitest";
const state=vi.hoisted(()=>({generation:1,client:vi.fn()}));
vi.mock("./client",()=>({apiClient:state.client,getAuthGeneration:()=>state.generation}));
import * as api from "./reminders";
it("binds reminders to expected account, original session and caller lifetime",()=>{
  let current=true;
  const context={expectedUserId:"owner",isCurrent:()=>current};
  for(const invoke of [()=>api.listReminders(context),()=>api.createReminder({source_kind:"dm",channel_id:"dm",message_id:"msg",due_at:"2099-01-01T00:00:00Z"},context),()=>api.updateReminder("id/path","2099-01-01T00:00:00Z",context),()=>api.cancelReminder("id/path",context)]){
    current=true;state.generation=1;invoke();const [url,options]=state.client.mock.lastCall!;
    expect(url).toContain("expected_user_id=owner");expect(options.timeoutMs).toBe(15000);expect(options.isCurrent()).toBe(true);
    current=false;expect(options.isCurrent()).toBe(false);current=true;state.generation++;expect(options.isCurrent()).toBe(false);
  }
  expect(state.client.mock.lastCall![0]).toContain("id%2Fpath");
});
