import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import AdminReportEvidence from "./AdminReportEvidence";
import type { AdminReportListItem } from "../../types";
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const report = { source_kind: "group", source_channel_id: "group", source_message_id: "message" } as AdminReportListItem;
it("does not expose text without the stored consent flag", () => {
  render(<AdminReportEvidence report={{ ...report, evidence_content: "unconsented secret", evidence_shared: false }} />);
  expect(screen.queryByText("unconsented secret")).not.toBeInTheDocument();
  expect(screen.getByText("platformReportNoSharedText")).toBeInTheDocument();
});
it("shows consented evidence as escaped text with provenance, not executable markup", () => {
  const { container } = render(<AdminReportEvidence report={{ ...report, evidence_content: "<img src=x onerror=alert(1)>", evidence_shared: true }} />);
  expect(screen.getByText("group / group / message")).toBeInTheDocument();
  expect(screen.getByText("platformReportEvidenceProvenance")).toBeInTheDocument();
  expect(container.querySelector("pre")?.textContent).toBe("<img src=x onerror=alert(1)>");
  expect(container.querySelector("img")).toBeNull();
});
