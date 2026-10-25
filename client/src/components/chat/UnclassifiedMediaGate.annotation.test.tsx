import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import UnclassifiedMediaGate from "./UnclassifiedMediaGate";
import { useAuthStore } from "../../stores/authStore";
import { usePreferencesStore } from "../../stores/preferencesStore";
import * as api from "../../api/mediaLabels";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }), initReactI18next: { type: "3rdParty", init: () => {} } }));
vi.mock("../../api/mediaLabels", () => ({ getMediaLabel: vi.fn(), setMediaLabel: vi.fn(), deleteMediaLabel: vi.fn() }));
const load = vi.mocked(api.getMediaLabel);
function gate(revision = "original") {
  return <UnclassifiedMediaGate sourceKind="channel" sourceChannelId="channel" messageId="message" revision={revision} authorId="other" identity="attachment"><span>protected media</span></UnclassifiedMediaGate>;
}
beforeEach(() => {
  vi.clearAllMocks();
  useAuthStore.setState({ user: { id: "owner" } as never });
  usePreferencesStore.setState({ data: { privacy: { sensitiveMedia: { channels: "block" }, disturbingMedia: { channels: "blur" } } } });
  load.mockResolvedValue({ success: true, data: { annotation: null } });
  vi.mocked(api.setMediaLabel).mockImplementation(async (reference, label) => {
    load.mockResolvedValue({ success: true, data: { annotation: { ...reference, label, version:"a".repeat(32) } } });
    return { success: true, data: { success: true } };
  });
  vi.mocked(api.deleteMediaLabel).mockImplementation(async () => {
    load.mockResolvedValue({ success: true, data: { annotation: null } });
    return { success: true, data: { success: true } };
  });
});
it("applies committed manual labels and restores protection when the label is removed", async () => {
  render(gate());
  expect(screen.queryByText("protected media")).not.toBeInTheDocument();
  await screen.findByRole("combobox");
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "ordinary" } });
  expect(screen.queryByText("protected media")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "mediaAnnotationSave" }));
  await screen.findByText("protected media");
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: "mediaAnnotationSave" }));
  await waitFor(() => expect(screen.queryByText("protected media")).not.toBeInTheDocument());
  expect(screen.queryByRole("button", { name: "mediaSafetyReveal" })).not.toBeInTheDocument();
});
it("does not reuse a revealing annotation for an edited message", async () => {
  load.mockImplementationOnce(async (reference) => ({ success: true, data: { annotation: { ...reference, label: "ordinary", version:"legacy" } } }));
  const rendered = render(gate());
  await screen.findByText("protected media");
  rendered.rerender(gate("2026-10-24T10:00:00Z"));
  expect(screen.queryByText("protected media")).not.toBeInTheDocument();
  await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  expect(load.mock.calls[1][0].revision).toBe("2026-10-24T10:00:00Z");
});
it("revokes an old temporary reveal after a failed annotation write", async () => {
  usePreferencesStore.setState({ data: { privacy: {} } });
  vi.mocked(api.setMediaLabel).mockResolvedValueOnce({ success: false, error: "offline" });
  render(gate());
  await screen.findByRole("combobox");
  fireEvent.click(screen.getByRole("button", { name: "mediaSafetyReveal" }));
  expect(screen.getByText("protected media")).toBeInTheDocument();
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "sexual" } });
  fireEvent.click(screen.getByRole("button", { name: "mediaAnnotationSave" }));
  await screen.findByRole("alert");
  expect(screen.queryByText("protected media")).not.toBeInTheDocument();
});
