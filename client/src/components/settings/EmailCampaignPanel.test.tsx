import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import EmailCampaignPanel from "./EmailCampaignPanel";

const mocks = vi.hoisted(() => {
  const authState = { user: { id: "admin-1", is_platform_admin: true } };
  const authStore = Object.assign((selector: (state: typeof authState) => unknown) => selector(authState), { getState: () => authState });
  return {
    authState,
    authStore,
    generation: 1,
    create: vi.fn(),
    preview: vi.fn(),
    publish: vi.fn(),
    confirm: vi.fn(),
  };
});
const t = (key: string) => key;
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t }), initReactI18next: { type: "3rdParty", init: () => {} } }));
vi.mock("../../api/emailCampaigns", () => ({
  createEmailCampaignDraft: mocks.create,
  getEmailCampaignPreview: mocks.preview,
  publishEmailCampaign: mocks.publish,
}));
vi.mock("../../api/client", () => ({ getAuthGeneration: () => mocks.generation }));
vi.mock("../../stores/authStore", () => ({ useAuthStore: mocks.authStore }));
vi.mock("../../stores/confirmStore", () => ({ useConfirmStore: { getState: () => ({ open: mocks.confirm }) } }));
vi.mock("./settingsWorkspaceContext", () => ({ useSettingsDraft: vi.fn() }));

const draft = {
  id: "ec_0123456789abcdef0123456789abcdef",
  category: "tips" as const,
  subject: "Subject",
  body: "<img src=x onerror=alert(1)>\nplain text",
  status: "draft" as const,
  expires_at: "2099-01-01T00:00:00Z",
  created_by: "admin-1",
  created_at: "2026-10-24T00:00:00Z",
  recipient_count: 0,
};
const preview = { campaign: draft, body_html: "<p>escaped server copy</p>", eligible_recipients: 17 };

describe("EmailCampaignPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    mocks.authState.user = { id: "admin-1", is_platform_admin: true };
    mocks.generation = 1;
    mocks.create.mockResolvedValue({ success: true, data: draft });
    mocks.preview.mockResolvedValue({ success: true, data: preview });
    mocks.publish.mockResolvedValue({ success: true, data: { ...draft, status: "published", recipient_count: 17 } });
    mocks.confirm.mockResolvedValue(true);
  });

  it("hides stale-session controls even if the same administrator stays mounted", () => {
    const view = render(<EmailCampaignPanel />);
    expect(screen.getByLabelText("emailCampaignSubject")).toBeInTheDocument();
    mocks.generation++;
    view.rerender(<EmailCampaignPanel />);
    expect(screen.queryByLabelText("emailCampaignSubject")).not.toBeInTheDocument();
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("is hidden for non-admins", () => {
    mocks.authState.user = { id: "member", is_platform_admin: false };
    const { container } = render(<EmailCampaignPanel />);
    expect(container).toBeEmptyDOMElement();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("creates only a draft, previews escaped plain text, and exposes an eligible count only", async () => {
    const { container } = render(<EmailCampaignPanel />);
    fireEvent.change(screen.getByLabelText("emailCampaignCategory"), { target: { value: "tips" } });
    fireEvent.change(screen.getByLabelText("emailCampaignSubject"), { target: { value: "Subject" } });
    fireEvent.change(screen.getByLabelText("emailCampaignBody"), { target: { value: draft.body } });
    fireEvent.click(screen.getByRole("button", { name: "emailCampaignCreate" }));

    await screen.findByText("emailCampaignEligible", { exact: false });
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ category: "tips", subject: "Subject", body: draft.body, expires_at: expect.any(String) }), expect.objectContaining({ isCurrent: expect.any(Function) }));
    expect(mocks.preview).toHaveBeenCalledWith(draft.id, expect.objectContaining({ isCurrent: expect.any(Function) }));
    expect(container.querySelector("pre")?.textContent).toBe(draft.body);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.queryByText("recipient@example.com")).not.toBeInTheDocument();
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it("requires confirmation and retries a failed publish against the same immutable campaign id", async () => {
    mocks.publish.mockResolvedValueOnce({ success: false, error: "temporary" });
    render(<EmailCampaignPanel />);
    fireEvent.change(screen.getByLabelText("emailCampaignSubject"), { target: { value: "Subject" } });
    fireEvent.change(screen.getByLabelText("emailCampaignBody"), { target: { value: "Plain body" } });
    fireEvent.click(screen.getByRole("button", { name: "emailCampaignCreate" }));
    await screen.findByText("emailCampaignEligible", { exact: false });

    fireEvent.click(screen.getByRole("button", { name: "emailCampaignPublish" }));
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ title: "emailCampaignPublish", message: expect.stringContaining("emailCampaignPublishConfirm") })));
    await waitFor(() => expect(mocks.publish).toHaveBeenCalledTimes(1));
    expect(mocks.publish).toHaveBeenLastCalledWith(draft.id, expect.objectContaining({ isCurrent: expect.any(Function) }));
    expect(mocks.preview).toHaveBeenCalledTimes(2); // create preview, then uncertain publish reconciliation

    fireEvent.click(screen.getByRole("button", { name: "emailCampaignPublish" }));
    await waitFor(() => expect(mocks.publish).toHaveBeenCalledTimes(2));
    expect(mocks.publish.mock.calls.map(([id]) => id)).toEqual([draft.id, draft.id]);
    await waitFor(() => expect(screen.getAllByText("emailCampaignPublished").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole("button", { name: "emailCampaignReset" }));
    expect(screen.getByLabelText("emailCampaignSubject")).toBeInTheDocument();
  });

  it("ignores a late create response after the administrator account changes", async () => {
    let finish!: (response: unknown) => void;
    mocks.create.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const view = render(<EmailCampaignPanel />);
    fireEvent.change(screen.getByLabelText("emailCampaignSubject"), { target: { value: "Subject" } });
    fireEvent.change(screen.getByLabelText("emailCampaignBody"), { target: { value: "Plain body" } });
    fireEvent.click(screen.getByRole("button", { name: "emailCampaignCreate" }));
    await waitFor(() => expect(mocks.create).toHaveBeenCalled());
    mocks.authState.user = { id: "other-admin", is_platform_admin: true };
    view.rerender(<EmailCampaignPanel />);
    expect(mocks.create.mock.lastCall?.[1].signal.aborted).toBe(true);
    await act(async () => finish({ success: true, data: draft }));
    expect(mocks.preview).not.toHaveBeenCalled();
  });

  it("keeps local campaign text when the panel is unmounted and restored in the same session", async () => {
    const view = render(<EmailCampaignPanel />);
    fireEvent.change(screen.getByLabelText("emailCampaignSubject"), { target: { value: "Keep this" } });
    fireEvent.change(screen.getByLabelText("emailCampaignBody"), { target: { value: "Local draft text" } });
    await waitFor(() => expect(Object.values(sessionStorage).some((value) => value.includes("Local draft text"))).toBe(true));
    view.unmount();
    render(<EmailCampaignPanel />);
    expect(screen.getByLabelText("emailCampaignSubject")).toHaveValue("Keep this");
    expect(screen.getByLabelText("emailCampaignBody")).toHaveValue("Local draft text");
  });

  it("does not copy one administrator's persisted draft into another account", async () => {
    const view = render(<EmailCampaignPanel />);
    fireEvent.change(screen.getByLabelText("emailCampaignSubject"), { target: { value: "Account A only" } });
    fireEvent.change(screen.getByLabelText("emailCampaignBody"), { target: { value: "Private campaign text" } });
    await waitFor(() => expect(Object.keys(sessionStorage).length).toBe(1));
    mocks.authState.user = { id: "admin-2", is_platform_admin: true };
    view.rerender(<EmailCampaignPanel />);
    expect(Object.keys(sessionStorage)).toHaveLength(1);
    expect(Object.values(sessionStorage)[0]).toContain("Private campaign text");
  });

  it("requires explicit confirmation before discarding an unpublished local draft", async () => {
    mocks.confirm.mockResolvedValue(false);
    render(<EmailCampaignPanel />);
    fireEvent.change(screen.getByLabelText("emailCampaignSubject"), { target: { value: "Keep this" } });
    fireEvent.change(screen.getByLabelText("emailCampaignBody"), { target: { value: "Unsaved text" } });
    fireEvent.click(screen.getByRole("button", { name: "emailCampaignReset" }));
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ message: "emailCampaignUnsaved" })));
    expect(screen.getByLabelText("emailCampaignSubject")).toHaveValue("Keep this");
    expect(screen.getByLabelText("emailCampaignBody")).toHaveValue("Unsaved text");
  });
});
