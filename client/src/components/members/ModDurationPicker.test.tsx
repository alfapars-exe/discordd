/**
 * ModDurationPicker — preset grid + dismissal + hint/warning line (B2).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import ModDurationPicker from "./ModDurationPicker";
import type { DurationPreset } from "./modDurationPresets";

const presets: DurationPreset[] = [
  { seconds: 60, labelKey: "dur_60s" },
  { seconds: 300, labelKey: "dur_5m" },
];

describe("ModDurationPicker", () => {
  const onPick = vi.fn();
  const onCancel = vi.fn();

  beforeEach(() => {
    onPick.mockReset();
    onCancel.mockReset();
  });

  it("renders a button for every preset", () => {
    render(<ModDurationPicker title="Pick" presets={presets} onPick={onPick} onCancel={onCancel} />);
    expect(screen.getByText("dur_60s")).toBeInTheDocument();
    expect(screen.getByText("dur_5m")).toBeInTheDocument();
  });

  it("clicking a preset calls onPick with its seconds", () => {
    render(<ModDurationPicker title="Pick" presets={presets} onPick={onPick} onCancel={onCancel} />);
    fireEvent.click(screen.getByText("dur_5m"));
    expect(onPick).toHaveBeenCalledWith(300);
  });

  it("Escape calls onCancel", () => {
    render(<ModDurationPicker title="Pick" presets={presets} onPick={onPick} onCancel={onCancel} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("clicking the backdrop calls onCancel", () => {
    const { container } = render(
      <ModDurationPicker title="Pick" presets={presets} onPick={onPick} onCancel={onCancel} />
    );
    const overlay = container.querySelector(".mod-picker-overlay");
    expect(overlay).not.toBeNull();
    fireEvent.click(overlay!);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("clicking inside the picker does not call onCancel", () => {
    const { container } = render(
      <ModDurationPicker title="Pick" presets={presets} onPick={onPick} onCancel={onCancel} />
    );
    const picker = container.querySelector(".mod-picker");
    expect(picker).not.toBeNull();
    fireEvent.click(picker!);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("renders the hint text when provided", () => {
    render(
      <ModDurationPicker
        title="Pick"
        presets={presets}
        hint="Stays in the server"
        onPick={onPick}
        onCancel={onCancel}
      />
    );
    expect(screen.getByText("Stays in the server")).toBeInTheDocument();
  });

  it("uses the soft hint class for the default (timeout) variant", () => {
    const { container } = render(
      <ModDurationPicker
        title="Pick"
        presets={presets}
        hint="Stays in the server"
        onPick={onPick}
        onCancel={onCancel}
      />
    );
    expect(container.querySelector(".mod-picker-hint")).not.toBeNull();
    expect(container.querySelector(".mod-picker-warning")).toBeNull();
  });

  it("uses the danger warning class for the ban variant", () => {
    const { container } = render(
      <ModDurationPicker
        title="Pick"
        presets={presets}
        variant="ban"
        hint="Removes the user from the server"
        onPick={onPick}
        onCancel={onCancel}
      />
    );
    expect(container.querySelector(".mod-picker-warning")).not.toBeNull();
    expect(container.querySelector(".mod-picker-hint")).toBeNull();
  });
});
