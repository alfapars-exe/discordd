import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

import ProfileAbout from "./ProfileAbout";

describe("ProfileAbout", () => {
  it("renders nothing when bio and pronouns are empty", () => {
    const { container } = render(<ProfileAbout bio={null} pronouns="" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders pronouns and the About me block", () => {
    render(<ProfileAbout bio={"line one\nline two"} pronouns="they/them" />);
    expect(screen.getByText("they/them")).toBeInTheDocument();
    expect(screen.getByText("profileAboutMe")).toBeInTheDocument();
    expect(screen.getByText(/line one/).textContent).toBe("line one\nline two");
  });

  it("renders markup in the bio as inert text", () => {
    const { container } = render(<ProfileAbout bio={'<img src=x onerror="alert(1)">'} />);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText('<img src=x onerror="alert(1)">')).toBeInTheDocument();
  });
});
