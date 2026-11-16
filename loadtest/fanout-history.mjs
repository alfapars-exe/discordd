import { createFanoutObserver } from "./fanout-observer.mjs";

/** Reconcile bounded, newest-first PostgreSQL history against every receiver. */
export async function reconcileFanoutHistory(profile, fetchPage, receipts, hash, limit = 100) {
  const observer = createFanoutObserver(profile);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("invalid_history_limit");
  const expected = profile.userIds.length * profile.messagesPerSender;
  let before = "", previousSequence = Infinity, pages = 0;
  for (;;) {
    if (++pages > Math.ceil(expected / limit) + 1) throw new Error("history_page_budget_exceeded");
    const page = await fetchPage({ before, limit });
    if (!Array.isArray(page?.messages) || page.messages.length > limit || typeof page.has_more !== "boolean" ||
        page.has_more_after !== false) throw new Error("invalid_history_page");
    for (const message of page.messages) {
      if (!Number.isSafeInteger(message.source_sequence) || message.source_sequence < 1 ||
          message.source_sequence >= previousSequence) throw new Error("history_order_not_descending");
      previousSequence = message.source_sequence;
      if (observer.observe({ op: "message_create", d: message }).kind !== "accepted") throw new Error("invalid_history_message");
    }
    if (!page.has_more) break;
    if (page.messages.length === 0 || observer.snapshot().received >= expected) throw new Error("unexpected_history_continuation");
    before = page.messages[page.messages.length - 1].id;
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
