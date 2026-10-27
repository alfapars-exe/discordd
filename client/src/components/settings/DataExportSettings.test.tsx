import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { publishAuthGenerationChange } from "../../api/authSessionEvents";
import DataExportSettings from "./DataExportSettings";

const mocks = vi.hoisted(() => ({ create: vi.fn(), get: vi.fn(), download: vi.fn(), downloadAttachments: vi.fn(), toast: vi.fn(), generation: 1, owner: "a" }));
const t = (key: string) => key;
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t }), initReactI18next: { type: "3rdParty", init: () => {} } }));
vi.mock("../../api/dataExport", () => ({ createDataExport: mocks.create, getDataExport: mocks.get, downloadDataExport: mocks.download, downloadDataExportAttachments: mocks.downloadAttachments }));
vi.mock("../../api/client", () => ({ getAuthGeneration: () => mocks.generation }));
vi.mock("../../stores/authStore", () => ({ useAuthStore: Object.assign((selector: (state: unknown) => unknown) => selector({ user: { id: mocks.owner } }), { getState: () => ({ user: { id: mocks.owner } }) }) }));
vi.mock("../../stores/toastStore", () => ({ useToastStore: (selector: (state: unknown) => unknown) => selector({ addToast: mocks.toast }) }));
const job = { id: "export-a", status: "ready", created_at: "2026-10-27T00:00:00Z", expires_at: "2026-10-28T00:00:00Z" };
const create = () => fireEvent.click(screen.getByRole("button", { name: "dataExport.create" }));
const advanceGeneration = () => {
  mocks.generation++;
  act(() => publishAuthGenerationChange(mocks.generation));
};

describe("DataExportSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks(); mocks.owner = "a"; mocks.generation = 1;
    publishAuthGenerationChange(mocks.generation);
    mocks.create.mockResolvedValue({ success: true, data: job });
    mocks.download.mockResolvedValue({ success: true });
    mocks.downloadAttachments.mockResolvedValue({ success: true });
    mocks.get.mockResolvedValue({ success: true, data: job });
  });
  it("reports failed export jobs as errors and allows another request", async () => {
    mocks.create.mockResolvedValueOnce({ success: true, data: { ...job, status: "failed" } });
    render(<DataExportSettings userID="a" />); create();
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith("error", "dataExport.error"));
    expect(screen.queryByRole("button", { name: "dataExport.download" })).not.toBeInTheDocument();
    create();
    await screen.findByRole("button", { name: "dataExport.download" });
    expect(mocks.toast).toHaveBeenCalledWith("success", "dataExport.ready");
  });
  it("recovers from rejected creation and download requests", async () => {
    mocks.create.mockRejectedValueOnce(new Error("offline"));
    render(<DataExportSettings userID="a" />); create();
    await waitFor(() => expect(screen.getByRole("button", { name: "dataExport.create" })).toBeEnabled());
    expect(mocks.toast).toHaveBeenCalledWith("error", "dataExport.error");
    create(); await screen.findByRole("button", { name: "dataExport.download" });
    mocks.download.mockRejectedValueOnce(new Error("offline"));
    fireEvent.click(screen.getByRole("button", { name: "dataExport.download" }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith("error", "dataExport.downloadError"));
    expect(screen.getByRole("button", { name: "dataExport.download" })).toBeEnabled();
    expect(mocks.download).toHaveBeenCalledWith(job, expect.any(Function));
  });
  it("discards a response when the same account signs in again", async () => {
    let finish!: (value: unknown) => void;
    mocks.create.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    render(<DataExportSettings userID="a" />); create(); advanceGeneration();
    await act(async () => finish({ success: true, data: job }));
    expect(mocks.toast).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "dataExport.download" })).not.toBeInTheDocument();
    expect(mocks.create.mock.calls[0][0]()).toBe(false);
    expect(screen.getByRole("button", { name: "dataExport.create" })).toBeEnabled();
    create(); await screen.findByRole("button", { name: "dataExport.download" });
    expect(mocks.toast).toHaveBeenCalledWith("success", "dataExport.ready");
  });
  it("requires a new export before downloading after the same account signs in again", async () => {
    render(<DataExportSettings userID="a" />); create();
    await screen.findByRole("button", { name: "dataExport.download" }); advanceGeneration();
    expect(mocks.download).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "dataExport.download" })).not.toBeInTheDocument();
    create(); await screen.findByRole("button", { name: "dataExport.download" });
    fireEvent.click(screen.getByRole("button", { name: "dataExport.download" }));
    await waitFor(() => expect(mocks.download).toHaveBeenCalledOnce());
  });
  it("hides an export immediately when the auth-store owner changes", async () => {
    const view = render(<DataExportSettings userID="a" />); create();
    await screen.findByRole("button", { name: "dataExport.download" });

    mocks.owner = "b";
    view.rerender(<DataExportSettings userID="a" />);

    expect(screen.queryByRole("button", { name: "dataExport.download" })).not.toBeInTheDocument();
    expect(screen.queryByText(/dataExport\.expires/)).not.toBeInTheDocument();
  });
  it("discards export results after the settings panel unmounts", async () => {
    let finish!: (value: unknown) => void;
    mocks.create.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const view = render(<DataExportSettings userID="a" />); create(); view.unmount();
    await act(async () => finish({ success: true, data: job }));
    expect(mocks.toast).not.toHaveBeenCalled();
    expect(mocks.create.mock.calls[0][0]()).toBe(false);
  });
  it("offers a separate attachment archive only when the server created one", async () => {
    mocks.create.mockResolvedValueOnce({ success: true, data: { ...job, attachments_ready: true } });
    render(<DataExportSettings userID="a" />); create();
    const attachmentButton = await screen.findByRole("button", { name: "dataExport.downloadAttachments" });
    fireEvent.click(attachmentButton);
    await waitFor(() => expect(mocks.downloadAttachments).toHaveBeenCalledWith(expect.objectContaining({ id: job.id, attachments_ready: true }), expect.any(Function)));
    expect(screen.getByRole("button", { name: "dataExport.download" })).toBeInTheDocument();
  });
  it("polls a durable pending archive until the server publishes it", async () => {
    mocks.create.mockResolvedValueOnce({ success: true, data: { ...job, attachments_ready: false, attachments_status: "pending" } });
    mocks.get.mockResolvedValueOnce({ success: true, data: { ...job, attachments_status: "building" } });
    mocks.get.mockResolvedValueOnce({ success: true, data: { ...job, attachments_ready: true, attachments_status: "ready" } });
    render(<DataExportSettings userID="a" />); create();
    expect(await screen.findByText("dataExport.attachmentsPreparing")).toBeInTheDocument();
    await screen.findByRole("button", { name: "dataExport.downloadAttachments" }, { timeout: 5000 });
    expect(mocks.get).toHaveBeenCalledWith(job.id, expect.any(Function));
  });
  it("ignores a late poll from the previous job after a new export is requested", async () => {
    let finishPoll!: (value: unknown) => void;
    let finishSecondCreate!: (value: unknown) => void;
    const first = { ...job, id: "export-a", attachments_status: "pending" as const };
    const second = { ...job, id: "export-b", expires_at: "2026-10-29T00:00:00Z", attachments_status: "failed" as const };
    mocks.create.mockResolvedValueOnce({ success: true, data: first }).mockImplementationOnce(() => new Promise(resolve => { finishSecondCreate = resolve; }));
    mocks.get.mockImplementationOnce(() => new Promise(resolve => { finishPoll = resolve; }));

    render(<DataExportSettings userID="a" />); create();
    await screen.findByText("dataExport.attachmentsPreparing");
    await waitFor(() => expect(mocks.get).toHaveBeenCalledOnce(), { timeout: 3000 });

    create();
    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(2));
    // Settle B and A in one React batch before effect cleanup can cancel A's request.
    await act(async () => {
      finishSecondCreate({ success: true, data: second });
      finishPoll({ success: true, data: { ...first, attachments_ready: true, attachments_status: "ready" } });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText("dataExport.attachmentsUnavailable")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "dataExport.downloadAttachments" })).not.toBeInTheDocument();
  });
  it("stops polling when the export job has expired or disappeared", async () => {
    mocks.create.mockResolvedValueOnce({ success: true, data: { ...job, attachments_status: "pending" } });
    mocks.get.mockResolvedValueOnce({ success: false, status: 404 });
    render(<DataExportSettings userID="a" />); create();

    await waitFor(() => expect(mocks.get).toHaveBeenCalledOnce(), { timeout: 3000 });
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith("error", "dataExport.jobUnavailable"));
    await new Promise(resolve => setTimeout(resolve, 3200));
    expect(mocks.get).toHaveBeenCalledOnce();
    expect(screen.queryByText("dataExport.attachmentsPreparing")).not.toBeInTheDocument();
  });
  it.each([401, 403])("clears the old export when polling loses authorization (%i)", async status => {
    mocks.create.mockResolvedValueOnce({ success: true, data: { ...job, attachments_status: "pending" } });
    mocks.get.mockResolvedValueOnce({ success: false, status });
    render(<DataExportSettings userID="a" />); create();

    await waitFor(() => expect(mocks.get).toHaveBeenCalledOnce(), { timeout: 3000 });
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith("error", "dataExport.jobUnavailable"));
    expect(screen.queryByText("dataExport.attachmentsPreparing")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "dataExport.download" })).not.toBeInTheDocument();
  });
  it("clears a polled export if the authentication generation changes in flight", async () => {
    let finishPoll!: (value: unknown) => void;
    mocks.create.mockResolvedValueOnce({ success: true, data: { ...job, attachments_status: "pending" } });
    mocks.get.mockImplementationOnce(() => new Promise(resolve => { finishPoll = resolve; }));
    render(<DataExportSettings userID="a" />); create();
    await screen.findByText("dataExport.attachmentsPreparing");
    await waitFor(() => expect(mocks.get).toHaveBeenCalledOnce(), { timeout: 3000 });
    advanceGeneration();

    await act(async () => finishPoll({ success: true, data: { ...job, attachments_ready: true, attachments_status: "ready" } }));

    expect(screen.queryByText("dataExport.attachmentsPreparing")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "dataExport.download" })).not.toBeInTheDocument();
    expect(mocks.toast).toHaveBeenCalledWith("error", "dataExport.jobUnavailable");
  });
  it("hides and retires the job when auth changes before the initial poll timer", async () => {
    mocks.create.mockResolvedValueOnce({ success: true, data: { ...job, attachments_status: "pending" } });
    render(<DataExportSettings userID="a" />); create();
    await screen.findByText("dataExport.attachmentsPreparing");

    advanceGeneration();

    expect(screen.queryByText("dataExport.attachmentsPreparing")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "dataExport.download" })).not.toBeInTheDocument();
    await new Promise(resolve => setTimeout(resolve, 1200));
    expect(mocks.get).not.toHaveBeenCalled();
  });
  it("hides and retires the job when auth changes between poll timers", async () => {
    mocks.create.mockResolvedValueOnce({ success: true, data: { ...job, attachments_status: "pending" } });
    mocks.get.mockResolvedValueOnce({ success: true, data: { ...job, attachments_status: "building" } });
    render(<DataExportSettings userID="a" />); create();
    await waitFor(() => expect(mocks.get).toHaveBeenCalledOnce(), { timeout: 3000 });
    await act(async () => { await Promise.resolve(); });

    advanceGeneration();

    expect(screen.queryByText("dataExport.attachmentsPreparing")).not.toBeInTheDocument();
    await new Promise(resolve => setTimeout(resolve, 1700));
    expect(mocks.get).toHaveBeenCalledOnce();
  });
  it("explains a missing local ZIP, keeps JSON, and recreates only on an explicit request", async () => {
    const missing = { ...job, attachments_status: "ready", attachments_ready: false, attachments_error: "archive_file_unavailable" };
    mocks.create.mockResolvedValueOnce({ success: true, data: missing }).mockResolvedValueOnce({ success: true, data: { ...job, id: "export-b", attachments_status: "ready", attachments_ready: true } });
    render(<DataExportSettings userID="a" />); create();
    await screen.findByText("dataExport.attachmentsMissing");
    expect(screen.getByRole("button", { name: "dataExport.download" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "dataExport.downloadAttachments" })).not.toBeInTheDocument();
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(mocks.get).not.toHaveBeenCalled();
    create();
    await screen.findByRole("button", { name: "dataExport.downloadAttachments" });
    expect(screen.queryByText("dataExport.attachmentsMissing")).not.toBeInTheDocument();
  });
  it("rechecks status when the ZIP disappears after a ready response", async () => {
    const ready = { ...job, attachments_status: "ready", attachments_ready: true };
    mocks.create.mockResolvedValueOnce({ success: true, data: ready });
    mocks.downloadAttachments.mockResolvedValueOnce({ success: false, status: 404 });
    mocks.get.mockResolvedValueOnce({ success: true, data: { ...ready, attachments_ready: false, attachments_error: "archive_file_unavailable" } });
    render(<DataExportSettings userID="a" />); create();
    fireEvent.click(await screen.findByRole("button", { name: "dataExport.downloadAttachments" }));
    await screen.findByText("dataExport.attachmentsMissing");
    await waitFor(() => expect(mocks.get).toHaveBeenCalledWith(job.id, expect.any(Function)));
    expect(screen.queryByRole("button", { name: "dataExport.downloadAttachments" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "dataExport.download" })).toBeInTheDocument();
  });
  it.each([401, 403, 404])("retires a disappeared ZIP job when its refreshed status is terminal (%i)", async status => {
    mocks.create.mockResolvedValueOnce({ success: true, data: { ...job, attachments_status: "ready", attachments_ready: true } });
    mocks.downloadAttachments.mockResolvedValueOnce({ success: false, status: 404 });
    mocks.get.mockResolvedValueOnce({ success: false, status });
    render(<DataExportSettings userID="a" />); create();
    fireEvent.click(await screen.findByRole("button", { name: "dataExport.downloadAttachments" }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith("error", "dataExport.jobUnavailable"));
    expect(screen.queryByRole("button", { name: "dataExport.download" })).not.toBeInTheDocument();
    expect(screen.queryByText("dataExport.attachmentsMissing")).not.toBeInTheDocument();
  });
  it.each([401, 403])("retires a ZIP job when download authorization is rejected (%i)", async status => {
    mocks.create.mockResolvedValueOnce({ success: true, data: { ...job, attachments_status: "ready", attachments_ready: true } });
    mocks.downloadAttachments.mockResolvedValueOnce({ success: false, status });
    render(<DataExportSettings userID="a" />); create();
    fireEvent.click(await screen.findByRole("button", { name: "dataExport.downloadAttachments" }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith("error", "dataExport.jobUnavailable"));
    expect(mocks.get).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "dataExport.download" })).not.toBeInTheDocument();
  });
  it("does not install another job returned by a stale availability refresh", async () => {
    mocks.create.mockResolvedValueOnce({ success: true, data: { ...job, attachments_status: "ready", attachments_ready: true } });
    mocks.downloadAttachments.mockResolvedValueOnce({ success: false, status: 404 });
    mocks.get.mockResolvedValueOnce({ success: true, data: { ...job, id: "export-other", attachments_status: "ready", attachments_ready: true } });
    render(<DataExportSettings userID="a" />); create();
    fireEvent.click(await screen.findByRole("button", { name: "dataExport.downloadAttachments" }));
    await waitFor(() => expect(mocks.get).toHaveBeenCalledOnce());
    expect(screen.getByText("dataExport.attachmentsMissing")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "dataExport.downloadAttachments" })).not.toBeInTheDocument();
  });
  it("does not restore a ZIP button from a late status response after auth changes", async () => {
    let finish!: (value: unknown) => void;
    const ready = { ...job, attachments_status: "ready", attachments_ready: true };
    mocks.create.mockResolvedValueOnce({ success: true, data: ready });
    mocks.downloadAttachments.mockResolvedValueOnce({ success: false, status: 404 });
    mocks.get.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    render(<DataExportSettings userID="a" />); create();
    fireEvent.click(await screen.findByRole("button", { name: "dataExport.downloadAttachments" }));
    await waitFor(() => expect(mocks.get).toHaveBeenCalledOnce());
    advanceGeneration();
    await act(async () => finish({ success: true, data: ready }));
    expect(screen.queryByRole("button", { name: "dataExport.downloadAttachments" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "dataExport.download" })).not.toBeInTheDocument();
  });
  it("reports a failed binary archive while keeping JSON available", async () => {
    mocks.create.mockResolvedValueOnce({ success: true, data: { ...job, attachments_status: "pending" } });
    mocks.get.mockResolvedValueOnce({ success: true, data: { ...job, attachments_status: "failed", attachments_error: "archive_unavailable" } });
    render(<DataExportSettings userID="a" />); create();
    expect(await screen.findByText("dataExport.attachmentsUnavailable", {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "dataExport.download" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "dataExport.downloadAttachments" })).not.toBeInTheDocument();
  });
});
