import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import PrivateMediaAnnotation, { type MediaAnnotationSource } from "./PrivateMediaAnnotation";
import { useAuthStore } from "../../stores/authStore";
import { useLightboxStore } from "../../stores/lightboxStore";
import { useE2EEStore } from "../../stores/e2eeStore";
import * as api from "../../api/mediaLabels";
import { receiveMediaLabelChange } from "../../utils/mediaLabelSync";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }), initReactI18next: { type: "3rdParty", init: () => {} } }));
vi.mock("../../api/mediaLabels", () => ({ getMediaLabel: vi.fn(), setMediaLabel: vi.fn(), deleteMediaLabel: vi.fn() }));
const source: MediaAnnotationSource = { source_kind: "dm", channel_id: "private", message_id: "message", revision: "original" };
const load = vi.mocked(api.getMediaLabel);
const save = vi.mocked(api.setMediaLabel);
function view(key = "one", identity = "private-media-url") {
  return <PrivateMediaAnnotation key={key} source={source} identity={identity} owner="owner">{(label) => <span>{label ?? "unknown"}</span>}</PrivateMediaAnnotation>;
}
describe("private media annotation lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuthStore.setState({ user: { id: "owner" } as never });
    useLightboxStore.getState().close();
    useE2EEStore.setState({localDeviceId:"device"});
    load.mockResolvedValue({ success: true, data: { annotation: null } });
    save.mockImplementation(async (reference, label) => {
      load.mockResolvedValue({ success: true, data: { annotation: { ...reference, label, version:"a".repeat(32) } } });
      return { success: true, data: { success: true } };
    });
    vi.mocked(api.deleteMediaLabel).mockImplementation(async () => {
      load.mockResolvedValue({ success: true, data: { annotation: null } });
      return { success: true, data: { success: true } };
    });
  });
  it("loads only a hashed reference, commits after success, and removes the label", async () => {
    render(view());
    await screen.findByRole("combobox");
    const [reference] = load.mock.calls[0];
    expect(reference.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(reference)).not.toContain("private-media-url");
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "ordinary" } });
    expect(screen.getByText("unknown")).toBeInTheDocument();
    useLightboxStore.getState().open({kind:"remote",src:"x",href:"x",filename:"x"});
    fireEvent.click(screen.getByRole("button", { name: "mediaAnnotationSave" }));
    await screen.findByText("ordinary");
    expect(useLightboxStore.getState().item).toBeNull();
    expect(save).toHaveBeenCalledWith(reference, "ordinary", expect.objectContaining({ isCurrent: expect.any(Function) }));
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "mediaAnnotationSave" }));
    await screen.findByText("unknown");
    expect(api.deleteMediaLabel).toHaveBeenCalledWith(reference, expect.any(Object));
  });
  it("rejects a mismatched persisted annotation and permits retry", async () => {
    load.mockImplementationOnce(async (reference) => ({ success: true, data: { annotation: { ...reference, message_id: "foreign", label: "ordinary", version:"legacy" } } }));
    render(view());
    await screen.findByRole("alert");
    expect(screen.getByText("unknown")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "mediaAnnotationRetry" }));
    await screen.findByRole("combobox");
    expect(load).toHaveBeenCalledTimes(2);
  });
  it("does not keep a revealing label when saving fails", async () => {
    load.mockImplementationOnce(async (reference) => ({ success: true, data: { annotation: { ...reference, label: "ordinary", version:"legacy" } } }));
    save.mockResolvedValueOnce({ success: false, error: "offline" });
    render(view());
    await screen.findByText("ordinary");
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "sexual" } });
    fireEvent.click(screen.getByRole("button", { name: "mediaAnnotationSave" }));
    await screen.findByRole("alert");
    expect(screen.getByText("unknown")).toBeInTheDocument();
  });
  it("ignores a completed write after account changes", async () => {
    let finish!: (value: Awaited<ReturnType<typeof api.setMediaLabel>>) => void;
    save.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    render(view());
    await screen.findByRole("combobox");
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "ordinary" } });
    fireEvent.click(screen.getByRole("button", { name: "mediaAnnotationSave" }));
    act(() => useAuthStore.setState({ user: { id: "other" } as never }));
    await act(async () => finish({ success: true, data: { success: true } }));
    expect(screen.queryByText("ordinary")).not.toBeInTheDocument();
    expect(save.mock.calls[0][2]?.isCurrent?.()).toBe(false);
  });
  it("aborts a replaced media reference and ignores its late load", async () => {
    let finish!: (value: Awaited<ReturnType<typeof api.getMediaLabel>>) => void;
    load.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const rendered = render(view());
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    const [oldReference, options] = load.mock.calls[0];
    rendered.rerender(view("two", "new-media"));
    await screen.findByRole("combobox");
    expect(options?.signal?.aborted).toBe(true);
    await act(async () => finish({ success: true, data: { annotation: { ...oldReference, label: "ordinary", version:"legacy" } } }));
    expect(screen.getByText("unknown")).toBeInTheDocument();
  });
  it("revokes temporary visibility and the matching viewer when loading throws", async () => {
    const reset = vi.fn();
    let fail!: (error: Error) => void;
    load.mockReturnValueOnce(new Promise((_, reject) => { fail = reject; }));
    render(<PrivateMediaAnnotation source={source} identity="media" owner="owner" onVisibilityReset={reset}>{(label) => <span>{label ?? "unknown"}</span>}</PrivateMediaAnnotation>);
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    useLightboxStore.getState().open({kind:"remote",src:"x",href:"x",filename:"x",messageId:"message"});
    await act(async () => fail(new Error("offline")));
    expect(reset).toHaveBeenCalledOnce();
    expect(useLightboxStore.getState().item).toBeNull();
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });
  it("invalidates a read already in flight and rejects its late revealing response", async () => {
    let finish!: (value: Awaited<ReturnType<typeof api.getMediaLabel>>) => void;
    load.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    load.mockImplementation(async (reference) => ({success:true,data:{annotation:{...reference,label:"sexual",version:"legacy"}}}));
    render(view());
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    const [reference,options]=load.mock.calls[0];
    act(() => receiveMediaLabelChange({...reference,user_id:"owner"}));
    await screen.findByText("sexual");
    expect(options?.signal?.aborted).toBe(true);
    await act(async () => finish({success:true,data:{annotation:{...reference,label:"ordinary",version:"legacy"}}}));
    expect(screen.queryByText("ordinary")).not.toBeInTheDocument();
  });
  it("refreshes another mounted copy after HTTP success without requiring a socket echo", async () => {
    render(<>{view("one")}{view("two")}</>);
    await waitFor(() => expect(screen.getAllByRole("combobox")).toHaveLength(2));
    fireEvent.change(screen.getAllByRole("combobox")[0],{target:{value:"ordinary"}});
    fireEvent.click(screen.getAllByRole("button",{name:"mediaAnnotationSave"})[0]);
    await waitFor(() => expect(screen.getAllByText("ordinary")).toHaveLength(2));
    expect(load).toHaveBeenCalledTimes(4);
  });
  it("rejects a write receipt after the encryption device is cleared", async () => {
    let finish!: (value: Awaited<ReturnType<typeof api.setMediaLabel>>) => void;
    save.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    render(view());
    await screen.findByRole("combobox");
    fireEvent.change(screen.getByRole("combobox"),{target:{value:"ordinary"}});
    fireEvent.click(screen.getByRole("button",{name:"mediaAnnotationSave"}));
    act(() => useE2EEStore.setState({localDeviceId:null}));
    await act(async () => finish({success:true,data:{success:true}}));
    expect(save.mock.calls[0][2]?.isCurrent?.()).toBe(false);
    expect(screen.queryByText("ordinary")).not.toBeInTheDocument();
  });
  it("sends the observed version and requires explicit reload after a conflict", async () => {
    load.mockImplementationOnce(async (reference) => ({success:true,data:{annotation:{...reference,label:"sexual",version:"legacy"}}}));
    save.mockResolvedValueOnce({success:false,code:"CONFLICT",error:"conflict"});
    render(view());
    await screen.findByText("sexual");
    fireEvent.change(screen.getByRole("combobox"),{target:{value:"ordinary"}});
    fireEvent.click(screen.getByRole("button",{name:"mediaAnnotationSave"}));
    await screen.findByText("mediaAnnotationConflict");
    expect(save.mock.calls[0][2]?.expectedVersion).toBe("legacy");
    expect(screen.getByText("unknown")).toBeInTheDocument();
    expect(save).toHaveBeenCalledOnce();
    expect(load).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button",{name:"mediaAnnotationRetry"}));
    await screen.findByRole("combobox");
    expect(load).toHaveBeenCalledTimes(2);
  });
  it("does not silently discard a dirty selection on another session's invalidation", async () => {
    render(view());
    await screen.findByRole("combobox");
    fireEvent.change(screen.getByRole("combobox"),{target:{value:"ordinary"}});
    const [reference]=load.mock.calls[0];
    act(() => receiveMediaLabelChange({...reference,user_id:"owner"}));
    await screen.findByText("mediaAnnotationConflict");
    expect(save).not.toHaveBeenCalled();
    expect(load).toHaveBeenCalledOnce();
    expect(screen.getByText("unknown")).toBeInTheDocument();
  });
  it("lets its version-checked write finish when its own socket invalidation arrives first", async () => {
    let finish!: (value: Awaited<ReturnType<typeof api.setMediaLabel>>) => void;
    save.mockReturnValueOnce(new Promise((resolve) => {finish=resolve;}));
    render(view());
    await screen.findByRole("combobox");
    fireEvent.change(screen.getByRole("combobox"),{target:{value:"ordinary"}});
    fireEvent.click(screen.getByRole("button",{name:"mediaAnnotationSave"}));
    const [reference]=load.mock.calls[0];
    act(() => receiveMediaLabelChange({...reference,user_id:"owner"}));
    expect(save.mock.calls[0][2]?.signal?.aborted).toBe(false);
    load.mockResolvedValue({success:true,data:{annotation:{...reference,label:"ordinary",version:"a".repeat(32)}}});
    await act(async () => finish({success:true,data:{success:true}}));
    await screen.findByText("ordinary");
    expect(screen.queryByText("mediaAnnotationConflict")).not.toBeInTheDocument();
  });
});
