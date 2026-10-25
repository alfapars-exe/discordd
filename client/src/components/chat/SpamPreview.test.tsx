import { render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import SpamPreview from "./SpamPreview";
import { useAuthStore } from "../../stores/authStore";
import { usePreferencesStore } from "../../stores/preferencesStore";
const spam=vi.hoisted(()=>({hidden:false,pending:false}));
vi.mock("../../hooks/useSpamVisibility",()=>({useSpamVisibility:()=>spam}));
vi.mock("react-i18next",async(original)=>({...await original<typeof import("react-i18next")>(),useTranslation:()=>({t:(key:string)=>key})}));
beforeEach(()=>{spam.hidden=false;spam.pending=false;useAuthStore.setState({user:{id:"me"} as NonNullable<ReturnType<typeof useAuthStore.getState>["user"]>});usePreferencesStore.setState({data:{privacy:{ignoredUsers:{other:true,me:true}}}});});
it.each(["channel","dm","group"] as const)("hides ignored plaintext and custom preview children in %s",kind=>{
  render(<SpamPreview kind={kind} message={{id:"m",user_id:"other",content:"private"}}><span>custom plaintext</span></SpamPreview>);
  expect(screen.getByText("ignoredMessage")).toBeInTheDocument();
  expect(screen.queryByText("custom plaintext")).not.toBeInTheDocument();
});
it("does not hide the account's own messages",()=>{
  render(<SpamPreview kind="group" message={{id:"m",user_id:"me",content:"own"}}/>);
  expect(screen.getByText("own")).toBeInTheDocument();
});
it("keeps spam quarantine ahead of ignored-message previews",()=>{
  spam.hidden=true;
  render(<SpamPreview kind="group" message={{id:"m",user_id:"other",content:"private"}}/>);
  expect(screen.getByText("spamHidden")).toBeInTheDocument();
  expect(screen.queryByText("private")).not.toBeInTheDocument();
});

it("hides all preview children while friendship is unresolved",()=>{spam.pending=true;render(<SpamPreview kind="dm" message={{id:"p",user_id:"other",content:"secret"}}><b>secret child</b></SpamPreview>);expect(screen.getByText("spamFilterPending")).toBeInTheDocument();expect(screen.queryByText("secret child")).toBeNull();});
