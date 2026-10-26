/** Deterministic local signals. Never uploads decrypted message content. */
export type SpamReason = "credential-link" | "mass-mention-links" | "repeated-links";
export type SpamClassification = { status: "unknown" | "classified"; spam: boolean; reasons: SpamReason[] };

function trimSentencePunctuation(value: string): string {
  // A closing bracket is part of a URL only when it balances one in its path.
  // This handles prose such as "(https://example.test/path)" without
  // rewriting legitimate URLs whose path itself ends in a bracket.
  const opens: Record<string, number> = { ")": 0, "]": 0, "}": 0 };
  const closes: Record<string, number> = { ")": 0, "]": 0, "}": 0 };
  const matching: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
  for (const char of value) {
    if (matching[char]) opens[matching[char]]++;
    else if (Object.hasOwn(closes, char)) closes[char]++;
  }
  // Count once: recounting the whole URL after every unmatched bracket would
  // make a sender-controlled closing-bracket burst quadratic on the UI thread.
  let end = value.length;
  while (end > 0) {
    const last = value[end - 1];
    if (".,!?;:".includes(last)) { end--; continue; }
    if (Object.hasOwn(closes, last) && closes[last] > opens[last]) {
      closes[last]--; end--; continue;
    }
    break;
  }
  return value.slice(0, end);
}

export function classifySpam(content: string | null | undefined): SpamClassification {
  if (typeof content !== "string") return { status: "unknown", spam: false, reasons: [] };
  const reasons: SpamReason[] = [];
  const urls: URL[] = [];
  // Match the chat renderer's pipe boundary: spoiler delimiters and adjacent
  // pipe-separated links must not become one invalid URL and evade detection.
  for (const match of content.matchAll(/https?:\/\/[^\s<>|]+/giu)) {
    const candidate = trimSentencePunctuation(match[0]);
    try { urls.push(new URL(candidate)); } catch { /* Invalid text is not a link signal. */ }
  }
  // URL user-info is frequently used to disguise the true destination.
  if (urls.some((url) => url.username !== "" || url.password !== "")) reasons.push("credential-link");
  const unique = new Set(urls.map((url) => `${url.origin}${url.pathname}${url.search}`));
  if (urls.length >= 6 && unique.size <= 2) reasons.push("repeated-links");
  if (urls.length >= 3 && /@(?:everyone|here)\b/iu.test(content)) reasons.push("mass-mention-links");
  return { status: "classified", spam: reasons.length > 0, reasons };
}

export function shouldFilterSpam(result: SpamClassification, mode: "all" | "nonfriends" | "off", isFriend: boolean, isSelf: boolean): boolean {
  return !isSelf && mode !== "off" && (mode === "all" || !isFriend) && result.status === "classified" && result.spam;
}
