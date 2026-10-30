import { expect, it, vi } from "vitest";
vi.mock("./locales/en/audit.json", () => { throw new Error("simulated bundled chunk failure"); });
import i18n, { changeLanguage, ensureNamespaces, i18nReady } from "./index";

it("keeps the current language and preference when a language chunk fails", async () => {
  await i18nReady;
  await ensureNamespaces(["audit"]);
  const before = i18n.language;
  const preference = localStorage.getItem("language");
  expect(await changeLanguage("en")).toBe(false);
  expect(i18n.language).toBe(before);
  expect(localStorage.getItem("language")).toBe(preference);
  expect(i18n.hasResourceBundle("en", "audit")).toBe(false);
});
