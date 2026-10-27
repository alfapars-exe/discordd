import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import DataExportSettings from "./DataExportSettings";

const mocks = vi.hoisted(() => ({ create: vi.fn(), get: vi.fn(), download: vi.fn(), downloadAttachments: vi.fn(), toast: vi.fn(), generation: 1, owner: "a" }));
const t = (key: string) => key;
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t }), initReactI18next: { type: "3rdParty", init: () => {} } }));
vi.mock("../../api/dataExport", () => ({ createDataExport: mocks.create, getDataExport: mocks.get, downloadDataExport: mocks.download, downloadDataExportAttachments: mocks.downloadAttachments }));
vi.mock("../../api/client", () => ({ getAuthGeneration: () => mocks.generation }));
vi.mock("../../stores/authStore", () => ({ useAuthStore: { getState: () => ({ user: { id: mocks.owner } }) } }));
vi.mock("../../stores/toastStore", () => ({ useToastStore: (selector: (state: unknown) => unknown) => selector({ addToast: mocks.toast }) }));
const job = { id: "export-a", status: "ready", created_at: "2026-10-27T00:00:00Z", expires_at: "2026-10-28T00:00:00Z" };
const create = () => fireEvent.click(screen.getByRole("button", { name: "dataExport.create" }));

describe("DataExportSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks(); mocks.owner = "a"; mocks.generation = 1;
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
    render(<DataExportSettings userID="a" />); create(); mocks.generation++;
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
    await screen.findByRole("button", { name: "dataExport.download" }); mocks.generation++;
    fireEvent.click(screen.getByRole("button", { name: "dataExport.download" }));
    expect(mocks.download).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "dataExport.download" })).not.toBeInTheDocument();
    create(); await screen.findByRole("button", { name: "dataExport.download" });
    fireEvent.click(screen.getByRole("button", { name: "dataExport.download" }));
    await waitFor(() => expect(mocks.download).toHaveBeenCalledOnce());
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
  it("reports a failed binary archive while keeping JSON available", async () => {
    mocks.create.mockResolvedValueOnce({ success: true, data: { ...job, attachments_status: "pending" } });
    mocks.get.mockResolvedValueOnce({ success: true, data: { ...job, attachments_status: "failed", attachments_error: "archive_unavailable" } });
    render(<DataExportSettings userID="a" />); create();
    expect(await screen.findByText("dataExport.attachmentsUnavailable", {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "dataExport.download" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "dataExport.downloadAttachments" })).not.toBeInTheDocument();
  });
});
