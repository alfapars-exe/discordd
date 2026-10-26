import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ReminderModal from "./ReminderModal";
import { cancelReminder, createReminder, listReminders, updateReminder } from "../../api/reminders";
const translate=vi.hoisted(()=>(key:string)=>key);
import {useAuthStore} from "../../stores/authStore";
import {useToastStore} from "../../stores/toastStore";
import {clearTokens} from "../../api/client";

vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({ t: translate, i18n: { language: "en" } }),
}));
vi.mock("../../api/reminders", () => ({
  listReminders: vi.fn(), createReminder: vi.fn(), updateReminder: vi.fn(), cancelReminder: vi.fn(),
}));

const source = { source_kind: "channel" as const, server_id: "s1", channel_id: "c1", message_id: "m1" };

describe("ReminderModal", () => {
  afterEach(()=>vi.restoreAllMocks());
  beforeEach(() => {
    localStorage.removeItem("hichat.reminder-attempts.v1");
    useAuthStore.setState({user:{id:"owner"} as never});
    useToastStore.setState({toasts:[]});
    vi.clearAllMocks();
    vi.mocked(listReminders).mockResolvedValue({ success: true, data: { reminders: [] } });
    vi.mocked(createReminder).mockResolvedValue({ success: true, data: { id: "r1", ...source, due_at: "2099-01-01T00:00:00Z", status: "scheduled" } });
    vi.mocked(updateReminder).mockResolvedValue({ success: true, data: { id: "r1", ...source, due_at: "2099-01-02T00:00:00Z", status: "scheduled" } });
    vi.mocked(cancelReminder).mockResolvedValue({ success: true, data: undefined });
  });

  it("contains keyboard focus, closes on Escape and restores the opener", () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const close = vi.fn();
    const view = render(<ReminderModal source={source} onClose={close} />);
    expect(screen.getByRole("dialog", { name: "reminderTitle" })).toBeInTheDocument();
    expect(screen.getByLabelText("reminderDue")).toHaveFocus();
    const first = screen.getByRole("button", { name: "reminderClose" });
    first.focus();
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    const last = screen.getByRole("button", { name: "reminderCreate" });
    expect(last).toHaveFocus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(first).toHaveFocus();
    opener.focus();
    expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: "Escape" });
    expect(close).toHaveBeenCalledOnce();
    view.unmount();
    expect(opener).toHaveFocus();
    opener.remove();
  });

  it("yields focus and Escape to a newer dialog and does not steal focus on unmount", () => {
    const close = vi.fn();
    const view = render(<ReminderModal source={source} onClose={close} />);
    const nested = document.createElement("div");
    nested.setAttribute("role", "alertdialog");
    nested.setAttribute("aria-modal", "true");
    const button = document.createElement("button");
    nested.append(button);
    document.body.append(nested);
    button.focus();
    expect(button).toHaveFocus();
    fireEvent.keyDown(button, { key: "Escape" });
    expect(close).not.toHaveBeenCalled();
    view.unmount();
    expect(button).toHaveFocus();
    nested.remove();
  });

  it("does not expose the previous account's late reminder list",async()=>{
    let finish!:(result:Awaited<ReturnType<typeof listReminders>>)=>void;
    vi.mocked(listReminders).mockReturnValueOnce(new Promise(resolve=>{finish=resolve;}));
    render(<ReminderModal source={source} onClose={vi.fn()}/>);
    await waitFor(()=>expect(listReminders).toHaveBeenCalledOnce());
    act(()=>useAuthStore.setState({user:{id:"new-owner"} as never}));
    await waitFor(()=>expect(listReminders).toHaveBeenCalledTimes(2));
    await act(async()=>finish({success:true,data:{reminders:[{id:"old",...source,due_at:"2099-01-01T00:00:00Z",status:"scheduled"}]}}));
    expect(screen.queryByText("channelReminder")).not.toBeInTheDocument();
  });
  it("invalidates old reads when the same account authenticates again",async()=>{
    let finish!:(result:Awaited<ReturnType<typeof listReminders>>)=>void;
    vi.mocked(listReminders).mockReturnValueOnce(new Promise(resolve=>{finish=resolve;}));
    render(<ReminderModal source={source} onClose={vi.fn()}/>);
    await waitFor(()=>expect(listReminders).toHaveBeenCalledOnce());
    act(()=>{clearTokens();useAuthStore.setState({user:{id:"owner"} as never});});
    await waitFor(()=>expect(listReminders).toHaveBeenCalledTimes(2));
    await act(async()=>finish({success:true,data:{reminders:[{id:"old",...source,due_at:"2099-01-01T00:00:00Z",status:"scheduled"}]}}));
    expect(screen.queryByText("channelReminder")).not.toBeInTheDocument();
  });
  it("ignores a pre-mutation list after the refreshed list has completed",async()=>{
    let finish!:(result:Awaited<ReturnType<typeof listReminders>>)=>void;
    vi.mocked(listReminders).mockReturnValueOnce(new Promise(resolve=>{finish=resolve;}));
    render(<ReminderModal source={source} onClose={vi.fn()}/>);
    await waitFor(()=>expect(listReminders).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button",{name:"reminderCreate"}));
    await waitFor(()=>expect(listReminders).toHaveBeenCalledTimes(2));
    await waitFor(()=>expect(screen.getByRole("button",{name:"reminderCreate"})).not.toBeDisabled());
    await act(async()=>finish({success:true,data:{reminders:[{id:"stale",...source,due_at:"2099-01-01T00:00:00Z",status:"scheduled"}]}}));
    expect(screen.queryByText("channelReminder")).not.toBeInTheDocument();
  });
  it("resets source context and rejects the previous source's late save effects",async()=>{
    let finish!:(result:Awaited<ReturnType<typeof createReminder>>)=>void;
    vi.mocked(createReminder).mockReturnValueOnce(new Promise(resolve=>{finish=resolve;}));
    const view=render(<ReminderModal source={source} onClose={vi.fn()}/>);
    fireEvent.click(screen.getByRole("button",{name:"reminderCreate"}));
    await waitFor(()=>expect(createReminder).toHaveBeenCalledOnce());
    view.rerender(<ReminderModal source={{...source,message_id:"m2"}} onClose={vi.fn()}/>);
    expect(screen.getByRole("button",{name:"reminderCreate"})).not.toBeDisabled();
    expect(vi.mocked(createReminder).mock.calls[0][1]?.isCurrent?.()).toBe(false);
    await act(async()=>finish({success:true,data:{id:"old",...source,due_at:"2099-01-01T00:00:00Z",status:"scheduled"}}));
    expect(useToastStore.getState().toasts.filter(toast=>toast.type==="success")).toEqual([]);
    fireEvent.click(screen.getByRole("button",{name:"reminderCreate"}));
    await waitFor(()=>expect(createReminder).toHaveBeenCalledWith(expect.objectContaining({message_id:"m2"}),expect.any(Object)));
  });
  it("does not announce late success after the dialog unmounts",async()=>{
    let finish!:(result:Awaited<ReturnType<typeof createReminder>>)=>void;
    vi.mocked(createReminder).mockReturnValueOnce(new Promise(resolve=>{finish=resolve;}));
    const view=render(<ReminderModal source={source} onClose={vi.fn()}/>);
    fireEvent.click(screen.getByRole("button",{name:"reminderCreate"}));
    await waitFor(()=>expect(createReminder).toHaveBeenCalledOnce());view.unmount();
    await act(async()=>finish({success:true,data:{id:"late",...source,due_at:"2099-01-01T00:00:00Z",status:"scheduled"}}));
    expect(useToastStore.getState().toasts.filter(toast=>toast.type==="success")).toEqual([]);
  });

  it("creates a reminder for the selected message", async () => {
    render(<ReminderModal source={source} onClose={vi.fn()} />);
    await waitFor(() => expect(listReminders).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText("reminderDue"), { target: { value: "2099-01-01T12:00" } });
    fireEvent.click(screen.getByRole("button", { name: "reminderCreate" }));
    await waitFor(() => expect(createReminder).toHaveBeenCalledWith(expect.objectContaining(source),expect.objectContaining({expectedUserId:"owner"})));
    expect(vi.mocked(createReminder).mock.calls[0][0].due_at).toContain("2099-01-01T");
  });

  it("releases the operation lock after transport failure and permits retry",async()=>{
    vi.mocked(createReminder).mockRejectedValueOnce(new Error("offline"));
    render(<ReminderModal source={source} onClose={vi.fn()} />);
    const save=screen.getByRole("button",{name:"reminderCreate"});
    fireEvent.click(save);
    await waitFor(()=>expect(createReminder).toHaveBeenCalledOnce());
    await waitFor(()=>expect(save).not.toBeDisabled());
    fireEvent.click(save);await waitFor(()=>expect(createReminder).toHaveBeenCalledTimes(2));
    const first=vi.mocked(createReminder).mock.calls[0][0].request_id;
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(vi.mocked(createReminder).mock.calls[1][0].request_id).toBe(first);
    await waitFor(()=>expect(save).not.toBeDisabled());fireEvent.click(save);
    await waitFor(()=>expect(createReminder).toHaveBeenCalledTimes(3));
    expect(vi.mocked(createReminder).mock.calls[2][0].request_id).not.toBe(first);
  });
  it("reuses a durable attempt after closing and reopening the dialog",async()=>{
    vi.mocked(createReminder).mockRejectedValueOnce(new Error("offline"));
    const first=render(<ReminderModal source={source} onClose={vi.fn()}/>);
    const due="2099-01-01T12:00";
    fireEvent.change(screen.getByLabelText("reminderDue"),{target:{value:due}});
    fireEvent.click(screen.getByRole("button",{name:"reminderCreate"}));
    await waitFor(()=>expect(createReminder).toHaveBeenCalledOnce());
    await waitFor(()=>expect(screen.getByRole("button",{name:"reminderCreate"})).not.toBeDisabled());
    const id=vi.mocked(createReminder).mock.calls[0][0].request_id;
    first.unmount();
    render(<ReminderModal source={source} onClose={vi.fn()}/>);
    fireEvent.change(screen.getByLabelText("reminderDue"),{target:{value:due}});
    fireEvent.click(screen.getByRole("button",{name:"reminderCreate"}));
    await waitFor(()=>expect(createReminder).toHaveBeenCalledTimes(2));
    expect(vi.mocked(createReminder).mock.calls[1][0].request_id).toBe(id);
  });
  it("does not issue a create when its durable identity cannot be saved",async()=>{
    const original=Storage.prototype.setItem;
    vi.spyOn(Storage.prototype,"setItem").mockImplementation(function(this:Storage,key,value){
      if(key==="hichat.reminder-attempts.v1")throw new Error("quota");
      original.call(this,key,value);
    });
    render(<ReminderModal source={source} onClose={vi.fn()}/>);
    fireEvent.click(screen.getByRole("button",{name:"reminderCreate"}));
    await waitFor(()=>expect(useToastStore.getState().toasts.some(item=>item.message==="reminderSaveFailed")).toBe(true));
    expect(createReminder).not.toHaveBeenCalled();
    expect(screen.getByRole("button",{name:"reminderCreate"})).not.toBeDisabled();
  });
  it("recovers an exact durable retry after its due time without claiming a new reminder",async()=>{
    const now=vi.spyOn(Date,"now").mockReturnValue(new Date("2030-01-01T00:00:00Z").getTime());
    vi.mocked(createReminder).mockRejectedValueOnce(new Error("response lost"));
    const first=render(<ReminderModal source={source} onClose={vi.fn()}/>);
    const due=screen.getByLabelText("reminderDue") as HTMLInputElement;
    const originalDue=due.value;
    fireEvent.click(screen.getByRole("button",{name:"reminderCreate"}));
    await waitFor(()=>expect(createReminder).toHaveBeenCalledOnce());
    await waitFor(()=>expect(screen.getByRole("button",{name:"reminderCreate"})).not.toBeDisabled());
    const request=vi.mocked(createReminder).mock.calls[0][0];first.unmount();
    now.mockReturnValue(new Date("2030-01-02T00:00:00Z").getTime());
    vi.mocked(createReminder).mockResolvedValueOnce({success:true,data:{id:"delivered",...source,due_at:request.due_at,status:"delivered"}});
    render(<ReminderModal source={source} onClose={vi.fn()}/>);
    fireEvent.change(screen.getByLabelText("reminderDue"),{target:{value:originalDue}});
    fireEvent.click(screen.getByRole("button",{name:"reminderCreate"}));
    await waitFor(()=>expect(createReminder).toHaveBeenCalledTimes(2));
    expect(vi.mocked(createReminder).mock.calls[1][0].request_id).toBe(request.request_id);
    await waitFor(()=>expect(useToastStore.getState().toasts.some(item=>item.message==="reminderAlreadyProcessed")).toBe(true));
    expect(useToastStore.getState().toasts.some(item=>item.message==="reminderCreated")).toBe(false);
  });
  it("retains identity and reports success when committed-request cleanup fails",async()=>{
    const original=Storage.prototype.removeItem;
    vi.spyOn(Storage.prototype,"removeItem").mockImplementation(function(this:Storage,key){
      if(key==="hichat.reminder-attempts.v1")throw new Error("storage unavailable");
      original.call(this,key);
    });
    render(<ReminderModal source={source} onClose={vi.fn()}/>);
    const save=screen.getByRole("button",{name:"reminderCreate"});
    fireEvent.click(save);
    await waitFor(()=>expect(createReminder).toHaveBeenCalledOnce());
    await waitFor(()=>expect(save).not.toBeDisabled());
    expect(useToastStore.getState().toasts.some(item=>item.message==="reminderCreated")).toBe(true);
    expect(useToastStore.getState().toasts.some(item=>item.message==="reminderSaveFailed")).toBe(false);
    fireEvent.click(save);
    await waitFor(()=>expect(createReminder).toHaveBeenCalledTimes(2));
    expect(vi.mocked(createReminder).mock.calls[1][0].request_id).toBe(vi.mocked(createReminder).mock.calls[0][0].request_id);
  });
  it("does not send duplicate cancellation while it is pending",async()=>{
    vi.mocked(listReminders).mockResolvedValue({success:true,data:{reminders:[{id:"r1",...source,due_at:"2099-01-01T00:00:00Z",status:"scheduled"}]}});
    let finish!:(result:{success:boolean})=>void;
    vi.mocked(cancelReminder).mockReturnValueOnce(new Promise(resolve=>{finish=resolve;}));
    render(<ReminderModal source={source} onClose={vi.fn()} />);
    const cancel=await screen.findByRole("button",{name:"reminderCancel"});
    fireEvent.click(cancel);fireEvent.click(cancel);expect(cancelReminder).toHaveBeenCalledOnce();
    finish({success:true});await waitFor(()=>expect(screen.queryByRole("button",{name:"reminderCancel"})).not.toBeInTheDocument());
  });

  it("edits and cancels an owned scheduled reminder", async () => {
    vi.mocked(listReminders).mockResolvedValue({ success: true, data: { reminders: [{ id: "r1", ...source, due_at: "2099-01-01T00:00:00Z", status: "scheduled" }] } });
    render(<ReminderModal source={source} onClose={vi.fn()} />);
    await screen.findByText("channelReminder");
    fireEvent.click(screen.getByRole("button", { name: "reminderEdit" }));
    fireEvent.change(screen.getByLabelText("reminderDue"), { target: { value: "2099-01-02T12:00" } });
    fireEvent.click(screen.getByRole("button", { name: "reminderUpdate" }));
    await waitFor(() => expect(updateReminder).toHaveBeenCalledWith("r1", expect.any(String),expect.objectContaining({expectedUserId:"owner"})));
    fireEvent.click(screen.getByRole("button", { name: "reminderCancel" }));
    await waitFor(() => expect(cancelReminder).toHaveBeenCalledWith("r1",expect.objectContaining({expectedUserId:"owner"})));
  });
});
