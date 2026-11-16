import { createFanoutObserver } from "./fanout-observer.mjs";

function historyKey(message) {
  const match = typeof message.created_at === "string" &&
    /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(message.created_at);
  if (!match || typeof message.id !== "string") throw new Error("invalid_history_order_key");
  const [year, month, day] = match[1].split("-").map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const time = Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}${match[6]}`);
  if (!Number.isFinite(time) || day < 1 || day > days[month - 1] ||
      Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59) {
    throw new Error("invalid_history_order_key");
  }
  return { instant: BigInt(time) * 1_000_000n + BigInt((match[5] ?? "").padEnd(9, "0")), id: message.id };
}

function compareHistoryKeys(left, right) {
  if (left.instant !== right.instant) return left.instant < right.instant ? -1 : 1;
  if (left.id === right.id) return 0;
  return left.id < right.id ? -1 : 1;
}

function sourceSequenceKey(message) {
  if (!Number.isSafeInteger(message.source_sequence) || message.source_sequence < 1) {
    throw new Error("invalid_history_order_key");
  }
  return { instant: BigInt(message.source_sequence), id: "" };
}

/** Walk older ASC REST pages using the explicitly selected database cursor contract. */
export async function reconcileFanoutHistory(profile, fetchPage, receipts, hash, limit = 100, order = "source_sequence") {
  const observer = createFanoutObserver(profile);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("invalid_history_limit");
  if (order !== "source_sequence" && order !== "created_at_id") throw new Error("invalid_history_order");
  const keyOf = order === "source_sequence" ? sourceSequenceKey : historyKey;
  const expected = profile.userIds.length * profile.messagesPerSender;
  let before = "", previousPageOldest = null, pages = 0;
  for (;;) {
    if (++pages > Math.ceil(expected / limit) + 1) throw new Error("history_page_budget_exceeded");
    const page = await fetchPage({ before, limit });
    if (!Array.isArray(page?.messages) || page.messages.length > limit || typeof page.has_more !== "boolean" ||
        page.has_more_after !== false) throw new Error("invalid_history_page");
    let previous = null, oldest = null;
    for (const message of page.messages) {
      const key = keyOf(message);
      if (previous && compareHistoryKeys(key, previous) <= 0) throw new Error("history_order_not_ascending");
      if (previousPageOldest && compareHistoryKeys(key, previousPageOldest) >= 0) throw new Error("history_page_not_older");
      oldest ??= key;
      previous = key;
      if (observer.observe({ op: "message_create", d: message }).kind !== "accepted") throw new Error("invalid_history_message");
    }
    if (!page.has_more) break;
    if (page.messages.length === 0 || observer.snapshot().received >= expected) throw new Error("unexpected_history_continuation");
    before = page.messages[0].id;
    previousPageOldest = oldest;
  }
  if (!observer.snapshot().complete) throw new Error("incomplete_history");
  const canonical = observer.receipts(), digest = hash(JSON.stringify(canonical));
  if (!Array.isArray(receipts) || receipts.length !== profile.userIds.length ||
      new Set(receipts.map(row => row.receiver)).size !== profile.userIds.length) throw new Error("invalid_receiver_set");
  for (const receipt of receipts) {
    if (!profile.userIds.includes(receipt.receiver) || receipt.digest !== digest || receipt.summary?.complete !== true)
      throw new Error("receiver_history_mismatch");
    const own = canonical.filter(row => row[0] === receipt.receiver);
    if (!Array.isArray(receipt.acknowledged) || receipt.acknowledged.length !== own.length) throw new Error("acknowledgement_history_mismatch");
    const acks = new Map(receipt.acknowledged);
    if (acks.size !== own.length || own.some(([, sequence, id]) => acks.get(sequence) !== id)) throw new Error("acknowledgement_history_mismatch");
  }
  return { persisted: canonical.length, historyPages: pages, digest };
}
