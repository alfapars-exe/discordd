export type SpamEvaluationCase = {
  id: string;
  content: string | null;
  expectedSpam: boolean;
  expectedReasons?: string[];
};

/**
 * Small, hand-curated regression corpus for deterministic local rules.
 * It intentionally is not a representative spam-quality/accuracy dataset.
 */
export const SPAM_EVALUATION_CORPUS: SpamEvaluationCase[] = [
  { id: "unknown-decrypted-content", content: null, expectedSpam: false },
  { id: "empty-message", content: "", expectedSpam: false },
  { id: "ordinary-turkish-text", content: "MERHABA! Toplantı yarın saat 10'da.", expectedSpam: false },
  { id: "single-link", content: "Kaynak: https://example.test/article", expectedSpam: false },
  { id: "mention-without-links", content: "@everyone toplantı başlıyor", expectedSpam: false },
  { id: "three-distinct-links", content: "https://a.test https://b.test https://c.test", expectedSpam: false },
  { id: "six-distinct-links", content: "https://a.test https://b.test https://c.test https://d.test https://e.test https://f.test", expectedSpam: false },
  { id: "invalid-url-text", content: "https:// not actually a URL", expectedSpam: false },
  { id: "balanced-url-parentheses", content: "https://example.test/path_(guide)", expectedSpam: false },
  { id: "ordinary-spoiler-link", content: "||https://example.test/article||", expectedSpam: false },
  { id: "encoded-pipe-in-single-url", content: "https://example.test/path%7Chttps://other.test", expectedSpam: false },
  { id: "credential-userinfo", content: "https://trusted.test@evil.test/login", expectedSpam: true, expectedReasons: ["credential-link"] },
  { id: "credential-link-in-spoiler", content: "||https://trusted.test@evil.test||", expectedSpam: true, expectedReasons: ["credential-link"] },
  { id: "pipe-separated-repeated-links", content: Array(6).fill("https://promo.test/claim").join("|"), expectedSpam: true, expectedReasons: ["repeated-links"] },
  { id: "spoiler-repeated-links", content: Array(6).fill("||https://promo.test/claim||").join(" "), expectedSpam: true, expectedReasons: ["repeated-links"] },
  { id: "mention-pipe-separated-links", content: "@everyone https://a.test|https://b.test|https://c.test", expectedSpam: true, expectedReasons: ["mass-mention-links"] },
  { id: "credential-password", content: "https://name:secret@evil.test/path", expectedSpam: true, expectedReasons: ["credential-link"] },
  { id: "encoded-userinfo", content: "https://%75ser@evil.test/login", expectedSpam: true, expectedReasons: ["credential-link"] },
  { id: "credential-link-sentence-punctuation", content: "Check this: https://trusted.test@evil.test/login.", expectedSpam: true, expectedReasons: ["credential-link"] },
  { id: "six-identical-links", content: Array(6).fill("https://promo.test/claim").join(" "), expectedSpam: true, expectedReasons: ["repeated-links"] },
  { id: "repeated-links-punctuation-variants", content: "https://promo.test/claim, https://promo.test/claim. https://promo.test/claim! https://promo.test/claim? https://promo.test/claim; https://promo.test/claim:", expectedSpam: true, expectedReasons: ["repeated-links"] },
  { id: "repeated-links-parenthesized", content: "(https://promo.test/claim) (https://promo.test/claim) (https://promo.test/claim) (https://promo.test/claim) (https://promo.test/claim) (https://promo.test/claim)", expectedSpam: true, expectedReasons: ["repeated-links"] },
  { id: "mention-link-burst", content: "@here https://a.test https://b.test https://c.test", expectedSpam: true, expectedReasons: ["mass-mention-links"] },
  { id: "everyone-link-burst-case-insensitive", content: "@EVERYONE https://a.test https://b.test https://c.test", expectedSpam: true, expectedReasons: ["mass-mention-links"] },
  { id: "mention-and-six-distinct-links", content: "@here https://a.test https://b.test https://c.test https://d.test https://e.test https://f.test", expectedSpam: true, expectedReasons: ["mass-mention-links"] },
];
