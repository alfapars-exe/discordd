import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

import ProfilePreviewCard from "./ProfilePreviewCard";

type Props = Parameters<typeof ProfilePreviewCard>[0];

function props(overrides: Partial<Props> = {}): Props {
  return {
    username: "alice",
    displayName: "",
    avatarUrl: null,
    animatedUrl: null,
    bannerUrl: null,
    accentColor: "",
    bio: "",
    pronouns: "",
    customStatus: "",
    ...overrides,
  };
}

describe("ProfilePreviewCard", () => {
  it("shows draft bio, pronouns and display name", () => {
    render(
      <ProfilePreviewCard
        {...props({ displayName: "Alice A.", bio: "Draft bio", pronouns: "she/her" })}
      />
    );
    expect(screen.getByText("Alice A.")).toBeInTheDocument();
    expect(screen.getByText("@alice")).toBeInTheDocument();
    expect(screen.getByText("Draft bio")).toBeInTheDocument();
    expect(screen.getByText("she/her")).toBeInTheDocument();
  });

  it("uses the draft accent colour when there is no banner", () => {
    const { container } = render(<ProfilePreviewCard {...props({ accentColor: "#abcdef" })} />);
    const hero = container.querySelector(".mc-hero-accent") as HTMLElement | null;
    expect(hero?.style.getPropertyValue("--mc-accent")).toBe("#abcdef");
  });

  it("shows a staged (object URL) banner", () => {
    const { container } = render(
      <ProfilePreviewCard {...props({ bannerUrl: "blob:http://localhost/123", accentColor: "#abcdef" })} />
    );
    expect(container.querySelector("img.mc-hero-banner")?.getAttribute("src")).toBe("blob:http://localhost/123");
    expect(container.querySelector(".mc-hero-accent")).toBeNull();
  });

  it("omits About me for a whitespace-only draft bio", () => {
    render(<ProfilePreviewCard {...props({ bio: "   " })} />);
    expect(screen.queryByText("profileAboutMe")).not.toBeInTheDocument();
  });
});
