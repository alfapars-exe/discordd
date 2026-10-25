import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, it } from "vitest";
import { useIgnoredMessageVisibility } from "./useIgnoredMessage";
import { useAuthStore } from "../stores/authStore";
import { usePreferencesStore } from "../stores/preferencesStore";
const message={id:"m",user_id:"other",content:"private",edited_at:null as string|null};
beforeEach(()=>{useAuthStore.setState({user:{id:"me"} as NonNullable<ReturnType<typeof useAuthStore.getState>["user"]>});usePreferencesStore.setState({data:{privacy:{ignoredUsers:{other:true,me:true}}}});});
it.each(["channel:c","dm:d","group:g"])("scopes explicit reveals to %s and the exact message",scope=>{
  const {result,rerender}=renderHook(({body,channel})=>useIgnoredMessageVisibility(body,channel),{initialProps:{body:message,channel:scope}});
  expect(result.current.hidden).toBe(true);
  act(()=>result.current.reveal());expect(result.current.hidden).toBe(false);
  rerender({body:{...message,edited_at:"changed"},channel:scope});expect(result.current.hidden).toBe(true);
  act(()=>result.current.reveal());
  rerender({body:{...message,content:"new body"},channel:scope});expect(result.current.hidden).toBe(true);
  act(()=>result.current.reveal());
  rerender({body:{...message,content:"new body"},channel:"different"});expect(result.current.hidden).toBe(true);
});
it("never carries a reveal to another account or privacy-policy revision",()=>{
  const {result}=renderHook(()=>useIgnoredMessageVisibility(message,"dm:d"));
  act(()=>result.current.reveal());
  act(()=>useAuthStore.setState({user:{id:"second"} as NonNullable<ReturnType<typeof useAuthStore.getState>["user"]>}));
  expect(result.current.hidden).toBe(true);
  act(()=>result.current.reveal());
  act(()=>usePreferencesStore.setState({data:{privacy:{ignoredUsers:{other:true}}}}));
  expect(result.current.hidden).toBe(true);
});
it("does not hide own messages even if malformed preferences include the owner",()=>{
  const {result}=renderHook(()=>useIgnoredMessageVisibility({...message,user_id:"me"},"dm:d"));
  expect(result.current.ignored).toBe(false);expect(result.current.hidden).toBe(false);
});
