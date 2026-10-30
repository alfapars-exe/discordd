import { describe, expect, it } from "vitest";
import i18n, { changeLanguage, ensureNamespaces, i18nReady } from "./index";

describe("bundled lazy translations", () => {
  it("starts with Turkish core and loads feature namespaces on demand", async () => {
    await i18nReady;
    expect(i18n.hasResourceBundle("tr", "common")).toBe(true);
    expect(i18n.hasResourceBundle("en", "cosmetics")).toBe(false);
    await ensureNamespaces(["cosmetics"]);
    expect(i18n.hasResourceBundle("tr", "cosmetics")).toBe(true);
  });
  it("loads active namespaces and fallback before committing the language", async () => {
    await ensureNamespaces(["voice", "chat"]);
    expect(await changeLanguage("en")).toBe(true);
    for (const ns of ["voice", "chat", "common", "auth"]) {
      expect(i18n.hasResourceBundle("en", ns)).toBe(true);
      expect(i18n.hasResourceBundle("tr", ns)).toBe(true);
    }
    expect(localStorage.getItem("language")).toBe("en");
    expect(i18n.t("common:loading")).not.toBe("loading");
    await changeLanguage("tr");
  });
  it("does not change language or persistence on an invalid request", async () => {
    const before = i18n.language, saved = localStorage.getItem("language");
    expect(await changeLanguage("invalid" as "tr")).toBe(false);
    expect(i18n.language).toBe(before);
    expect(localStorage.getItem("language")).toBe(saved);
  });
  it("latest language request wins", async () => {
    await Promise.all([changeLanguage("en"), changeLanguage("tr")]);
    expect(i18n.language).toBe("tr");
    expect(localStorage.getItem("language")).toBe("tr");
  });
});
