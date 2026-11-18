import { StrictMode } from "react";
import { act, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { listServerApplications } from "../../api/applications";
import ServerApplicationSettings from "./ServerApplicationSettings";

vi.mock("../../api/applications", () => ({ listServerApplications: vi.fn() }));
vi.mock("../../stores/settingsStore", () => ({ useSettingsStore: () => "server" }));
let t = (key: string) => key;
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t }) }));

it("reports a rejected application list request and releases the form", async () => {
  vi.mocked(listServerApplications).mockRejectedValueOnce(new Error("offline"));
  render(<ServerApplicationSettings />);
  expect(await screen.findByRole("alert")).toHaveTextContent("serverApplications.loadError");
  expect(screen.getByRole("textbox")).toBeEnabled();
});

it("ignores a superseded request that fails after the current list loads", async () => {
  let failFirst!: (error: Error) => void;
  vi.mocked(listServerApplications)
    .mockImplementationOnce(() => new Promise((_, reject) => { failFirst = reject; }))
    .mockResolvedValueOnce({ success: true, data: { applications: [] } });

  render(<StrictMode><ServerApplicationSettings /></StrictMode>);
  await screen.findByRole("region", { busy: false });
  expect(listServerApplications).toHaveBeenCalledTimes(2);
  await act(async () => { failFirst(new Error("stale response")); });

  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.getByRole("textbox")).toBeEnabled();
});

it("translates an existing error without reloading the server list", async () => {
  vi.mocked(listServerApplications).mockRejectedValueOnce(new Error("offline"));
  const panel = render(<ServerApplicationSettings />);
  await screen.findByRole("alert");
  const original = t;
  try {
    t = key => "translated " + key;
    panel.rerender(<ServerApplicationSettings />);
    expect(screen.getByRole("alert")).toHaveTextContent("translated serverApplications.loadError");
    expect(listServerApplications).toHaveBeenCalledTimes(1);
  } finally {
    t = original;
  }
});
