import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { listServerApplications } from "../../api/applications";
import ServerApplicationSettings from "./ServerApplicationSettings";

vi.mock("../../api/applications", () => ({ listServerApplications: vi.fn() }));
vi.mock("../../stores/settingsStore", () => ({ useSettingsStore: () => "server" }));
const t = (key: string) => key;
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t }) }));

it("reports a rejected application list request and releases the form", async () => {
  vi.mocked(listServerApplications).mockRejectedValueOnce(new Error("offline"));
  render(<ServerApplicationSettings />);
  expect(await screen.findByRole("alert")).toHaveTextContent("serverApplications.loadError");
  expect(screen.getByRole("textbox")).toBeEnabled();
});
