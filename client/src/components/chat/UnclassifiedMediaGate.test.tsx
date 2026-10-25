import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import UnclassifiedMediaGate from "./UnclassifiedMediaGate";
import { unknownMediaMode } from "../../utils/mediaVisibility";
import { usePreferencesStore } from "../../stores/preferencesStore";
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }), initReactI18next: { type: "3rdParty", init: () => {} } }));

describe("unclassified attachment protection", () => {
  beforeEach(() => usePreferencesStore.setState({ data: {} }));
  it("uses the stricter category and safe scope defaults", () => {
    expect(unknownMediaMode(undefined, "channels")).toBe("blur");
    expect(unknownMediaMode(undefined, "friendDMs")).toBe("show");
    expect(unknownMediaMode({ sensitiveMedia: { channels: "show" }, disturbingMedia: { channels: "block" } }, "channels")).toBe("block");
  });
  it("does not mount media until explicitly revealed, and resets for another message", () => {
    const mounted = vi.fn();
    function Media() { mounted(); return <span>media</span>; }
    const view = render(<UnclassifiedMediaGate authorId="other" identity="one"><Media /></UnclassifiedMediaGate>);
    expect(mounted).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "mediaSafetyReveal" }));
    expect(screen.getByText("media")).toBeInTheDocument();
    view.rerender(<UnclassifiedMediaGate authorId="other" identity="two"><Media /></UnclassifiedMediaGate>);
    expect(screen.queryByText("media")).not.toBeInTheDocument();
  });
  it("does not offer reveal when blocked", () => {
    usePreferencesStore.setState({ data: { privacy: { sensitiveMedia: { channels: "block" } } } });
    render(<UnclassifiedMediaGate authorId="other" identity="one"><span>media</span></UnclassifiedMediaGate>);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByText("media")).not.toBeInTheDocument();
  });
  it("uses private preferences for group messages outside a chat provider", () => {
    usePreferencesStore.setState({ data: { privacy: {
      sensitiveMedia: { channels: "show", otherDMs: "block" },
      disturbingMedia: { channels: "show", otherDMs: "show" },
    } } });
    render(<UnclassifiedMediaGate privateConversation authorId="other" identity="group"><span>private media</span></UnclassifiedMediaGate>);
    expect(screen.getByText("mediaSafetyBlocked")).toBeInTheDocument();
    expect(screen.queryByText("private media")).not.toBeInTheDocument();
  });
});
