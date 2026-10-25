import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import GroupSpamGate from "./GroupSpamGate";
import type { GroupDMMessage } from "../../types/groupDM";
import { useAuthStore } from "../../stores/authStore";
import { usePreferencesStore } from "../../stores/preferencesStore";
const state = vi.hoisted(() => ({ hidden: false, pending: false }));
vi.mock("../../hooks/useSpamVisibility", () => ({ useSpamVisibility: () => ({ hidden: state.hidden, pending:state.pending, pendingError:false, retryRelationship:vi.fn(), reasons: [], restore: vi.fn(), retry: vi.fn(), syncError: false }) }));
vi.mock("react-i18next", async (original) => ({...await original<typeof import("react-i18next")>(), useTranslation: () => ({ t: (key: string) => key }) }));
const message = { id:"m",group_id:"g",user_id:"other",content:"hello" } as GroupDMMessage;
beforeEach(() => { state.hidden=false;state.pending=false; useAuthStore.setState({user:{id:"me"} as NonNullable<ReturnType<typeof useAuthStore.getState>["user"]>}); usePreferencesStore.setState({data:{privacy:{ignoredUsers:{}}}}); });
it("dispatches only focused group actions and leaves child controls alone", () => {
  state.hidden = false; const run = vi.fn();
  render(<GroupSpamGate message={message} keyboardActions={[{id:"reply",label:"reply",run}]}><button>child</button></GroupSpamGate>);
  fireEvent.keyDown(screen.getByRole("group"), {code:"KeyR",key:"r"});
  expect(run).toHaveBeenCalledOnce();
  fireEvent.keyDown(screen.getByRole("button",{name:"child"}), {code:"KeyR",key:"r"});
  expect(run).toHaveBeenCalledOnce();
});
it("dispatches Alt+Enter to the same supplied unread action",()=>{
  const run=vi.fn();
  render(<GroupSpamGate message={message} keyboardActions={[{id:"mark-unread",label:"unread",run}]}><p>body</p></GroupSpamGate>);
  fireEvent.keyDown(screen.getByRole("group"),{code:"Enter",key:"Enter",altKey:true});
  expect(run).toHaveBeenCalledOnce();
});
it("gates pointer and keyboard content for ignored authors until an explicit scoped reveal", () => {
  usePreferencesStore.setState({data:{privacy:{ignoredUsers:{other:true}}}});
  const copy=vi.fn();
  const {rerender}=render(<GroupSpamGate message={message} keyboardActions={[{id:"copy",label:"copy",run:copy}]}><button onClick={copy}>copy body</button></GroupSpamGate>);
  expect(screen.queryByText("copy body")).not.toBeInTheDocument();
  fireEvent.keyDown(screen.getByRole("group"),{code:"KeyC",key:"c",ctrlKey:true});
  expect(copy).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button",{name:"showIgnoredMessage"}));
  fireEvent.keyDown(screen.getByRole("group"),{code:"KeyC",key:"c",ctrlKey:true});
  expect(copy).toHaveBeenCalledOnce();
  rerender(<GroupSpamGate message={{...message,content:"edited"}}><p>new body</p></GroupSpamGate>);
  expect(screen.queryByText("new body")).not.toBeInTheDocument();
});
it("does not retain a reveal across account or policy changes", () => {
  usePreferencesStore.setState({data:{privacy:{ignoredUsers:{other:true}}}});
  render(<GroupSpamGate message={message}><p>body</p></GroupSpamGate>);
  fireEvent.click(screen.getByRole("button",{name:"showIgnoredMessage"}));
  expect(screen.getByText("body")).toBeInTheDocument();
  act(()=>usePreferencesStore.setState({data:{privacy:{ignoredUsers:{other:true},spamFilter:"all"}}}));
  expect(screen.queryByText("body")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button",{name:"showIgnoredMessage"}));
  act(()=>useAuthStore.setState({user:{id:"second"} as NonNullable<ReturnType<typeof useAuthStore.getState>["user"]>}));
  expect(screen.queryByText("body")).not.toBeInTheDocument();
});
it("does not gate the account's own messages and blocks speech on undecrypted rows", () => {
  usePreferencesStore.setState({data:{privacy:{ignoredUsers:{me:true}}}});
  const speak=vi.fn();
  render(<GroupSpamGate message={{...message,user_id:"me",content:null}} keyboardActions={[{id:"speak",label:"speak",run:speak}]}><p>unavailable</p></GroupSpamGate>);
  expect(screen.getByText("unavailable")).toBeInTheDocument();
  fireEvent.keyDown(screen.getByRole("group"),{code:"KeyS",key:"s"});
  expect(speak).not.toHaveBeenCalled();
});
it("blocks content actions on hidden messages but allows returning to the group composer", () => {
  state.hidden = true; const run = vi.fn();
  render(<div className="group-dm-chat"><GroupSpamGate message={message} keyboardActions={[{id:"reply",label:"reply",run}]}><p>secret</p></GroupSpamGate><form className="group-dm-composer"><textarea aria-label="composer" /></form></div>);
  expect(screen.queryByText("secret")).not.toBeInTheDocument();
  fireEvent.keyDown(screen.getByRole("group"), {code:"KeyR",key:"r"});
  expect(run).not.toHaveBeenCalled();
  fireEvent.keyDown(screen.getByRole("group"), {code:"Escape",key:"Escape"});
  expect(screen.getByRole("textbox")).toHaveFocus();
});

it("blocks group content, children and shortcuts while relationship is pending",()=>{state.pending=true;const run=vi.fn();render(<GroupSpamGate message={message} keyboardActions={[{id:"reply",label:"reply",run}]}><p>pending secret</p></GroupSpamGate>);expect(screen.queryByText("pending secret")).toBeNull();expect(screen.getByText("spamFilterPending")).toBeInTheDocument();fireEvent.keyDown(screen.getByRole("group"),{code:"KeyR",key:"r"});expect(run).not.toHaveBeenCalled();});
