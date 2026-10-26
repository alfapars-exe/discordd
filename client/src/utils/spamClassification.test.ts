import { describe, expect, it } from "vitest";
import { classifySpam, shouldFilterSpam } from "./spamClassification";
import { SPAM_EVALUATION_CORPUS } from "./spamClassification.corpus";

describe("local spam signals", () => {
  it("keeps unavailable plaintext unknown", () => {
    expect(classifySpam(null).status).toBe("unknown");
    expect(classifySpam(null).spam).toBe(false);
  });
  it("does not flag normal conversation, single links or capitals", () => {
    for (const text of ["MERHABA!", "https://example.com", "@everyone toplantı başlıyor", ""]) expect(classifySpam(text).spam).toBe(false);
  });
  it("detects disguised destinations and repeated link bursts", () => {
    expect(classifySpam("https://trusted.example@evil.example/login").reasons).toContain("credential-link");
    expect(classifySpam("https://example.com ".repeat(6)).reasons).toContain("repeated-links");
    expect(classifySpam("@here https://a.test https://b.test https://c.test").reasons).toContain("mass-mention-links");
  });
  it("honors off, friends-only exclusion and self messages", () => {
    const spam = classifySpam("https://a.test@b.test");
    expect(shouldFilterSpam(spam,"all",true,false)).toBe(true);
    expect(shouldFilterSpam(spam,"nonfriends",true,false)).toBe(false);
    expect(shouldFilterSpam(spam,"nonfriends",false,false)).toBe(true);
    expect(shouldFilterSpam(spam,"off",false,false)).toBe(false);
    expect(shouldFilterSpam(spam,"all",false,true)).toBe(false);
  });

  it("normalizes mixed trailing punctuation without recounting bracket bursts", () => {
    const links = ["https://example.test/a).,", "https://example.test/a)]!", "https://example.test/a"].join(" ");
    expect(classifySpam(`${links} ${links}`).reasons).toContain("repeated-links");
    const longLink = `https://example.test/a${")".repeat(10000)}`;
    expect(classifySpam(`${longLink} `.repeat(6)).reasons).toContain("repeated-links");
  });

  it("matches the curated deterministic regression corpus", () => {
    const counts = { tp: 0, fp: 0, tn: 0, fn: 0, unknown: 0 };
    for (const sample of SPAM_EVALUATION_CORPUS) {
      const result = classifySpam(sample.content);
      if (result.status === "unknown") counts.unknown++;
      else if (result.spam && sample.expectedSpam) counts.tp++;
      else if (result.spam) counts.fp++;
      else if (sample.expectedSpam) counts.fn++;
      else counts.tn++;
      expect(result.spam, sample.id).toBe(sample.expectedSpam);
      expect(result.status, sample.id).toBe(sample.content === null ? "unknown" : "classified");
      if (sample.expectedReasons) expect(result.reasons, sample.id).toEqual(sample.expectedReasons);
    }
    expect(counts).toEqual({ tp: 14, fp: 0, tn: 10, fn: 0, unknown: 1 });
  });
});
