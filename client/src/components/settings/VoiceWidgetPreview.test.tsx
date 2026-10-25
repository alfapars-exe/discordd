import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import en from "../../i18n/locales/en/settings.json";
import VoiceWidgetPreview from "./VoiceWidgetPreview";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key.split(".").reduce<unknown>((value, part) => (value as Record<string, unknown>)?.[part], en) ?? key }),
}));

afterEach(cleanup);

const base = { enabled: true, mode: "desktop" as const, speakingOpacity: 90, idleOpacity: 30, scale: 125, position: "bottom-right" as const, speakingOnly: false, avatarSize: "small" as const, nameDisplay: "always" as const, maxParticipants: 25 };

describe("VoiceWidgetPreview", () => {
  it("labels deterministic sample users and applies scale, position and opacity preferences", () => {
    render(<VoiceWidgetPreview {...base} />);
    const preview = screen.getByRole("img", { name: en.voiceOverlayPreviewAria });
    expect(screen.getByText(en.voiceOverlayPreviewSample)).toBeInTheDocument();
    expect(within(preview).getByText(en.voiceOverlaySampleUserOne)).toBeInTheDocument();
    expect(within(preview).getByText(en.voiceOverlaySampleUserTwo)).toBeInTheDocument();
    expect(preview).toHaveClass("position-bottom-right");
    expect(preview).toHaveAttribute("data-overlay-mode", "desktop");
    expect(preview.querySelector(".voice-widget-preview-widget")).toHaveStyle({ transform: "scale(1.25)", transformOrigin: "bottom right" });
    expect(within(preview).getByText(en.voiceOverlaySampleUserTwo).closest(".voice-overlay-row")).toHaveStyle({ opacity: "0.3" });
  });

  it("filters sample rows when speaking-only is selected", () => {
    render(<VoiceWidgetPreview {...base} speakingOnly />);
    const preview = screen.getByRole("img", { name: en.voiceOverlayPreviewAria });
    expect(within(preview).getByText(en.voiceOverlaySampleUserOne)).toBeInTheDocument();
    expect(within(preview).queryByText(en.voiceOverlaySampleUserTwo)).not.toBeInTheDocument();
    expect(within(preview).queryByText(en.voiceOverlaySampleUserThree)).not.toBeInTheDocument();
  });

  it("previews large avatars, name visibility, and the participant cap", () => {
    const { rerender } = render(<VoiceWidgetPreview {...base} avatarSize="large" nameDisplay="speaking" maxParticipants={2} />);
    const preview = screen.getByRole("img", { name: en.voiceOverlayPreviewAria });
    const widget = preview.querySelector(".voice-widget-preview-widget")!;
    expect(widget).toHaveAttribute("data-avatar-size", "large");
    expect(within(preview).getByText(en.voiceOverlaySampleUserOne)).toBeInTheDocument();
    expect(within(preview).queryByText(en.voiceOverlaySampleUserTwo)).not.toBeInTheDocument();
    expect(preview.querySelectorAll(".voice-overlay-row")).toHaveLength(2);

    rerender(<VoiceWidgetPreview {...base} nameDisplay="never" maxParticipants={1} />);
    expect(preview.querySelectorAll(".voice-overlay-row")).toHaveLength(1);
    expect(preview.querySelector(".voice-overlay-row span")).toBeNull();

    rerender(<VoiceWidgetPreview {...base} maxParticipants={0} />);
    expect(within(preview).getByText(en.voiceOverlayMaxParticipantsOff)).toBeInTheDocument();
    expect(preview.querySelectorAll(".voice-overlay-row")).toHaveLength(0);
  });

  it("shows a disabled state instead of sample participants when the widget is off", () => {
    render(<VoiceWidgetPreview {...base} enabled={false} />);
    const preview = screen.getByRole("img", { name: en.voiceOverlayPreviewAria });
    expect(within(preview).getByText(en.voiceOverlayPreviewDisabled)).toBeInTheDocument();
    expect(within(preview).queryByText(en.voiceOverlaySampleUserOne)).not.toBeInTheDocument();
    expect(screen.getByText(en.voiceOverlayPreviewSample)).toBeInTheDocument();
  });
});
