import { beforeEach, expect, it, vi } from "vitest";
import { publishAuthGenerationChange, publishAuthOwnerChange } from "../api/authSessionEvents";
import { reserveCachedMessageDeletion, waitForCachedMessageDeletions } from "./cachedMessageDeletions";

let generation = 0;
beforeEach(() => { publishAuthOwnerChange("alice"); publishAuthGenerationChange(++generation); });

it("waits for every accepted deletion, without blocking another kind or channel", async () => {
  const first = reserveCachedMessageDeletion("channel", "room"), second = reserveCachedMessageDeletion("channel", "room");
  const done = vi.fn(); const waiting = waitForCachedMessageDeletions("channel", "room").then(done);
  await waitForCachedMessageDeletions("channel", "other");
  await waitForCachedMessageDeletions("dm", "room");
  first(); first(); await Promise.resolve(); expect(done).not.toHaveBeenCalled();
  second(); await waiting; expect(done).toHaveBeenCalledOnce();
});

it("rechecks a replacement busy interval before letting a scan start", async () => {
  const first = reserveCachedMessageDeletion("channel", "room");
  const done = vi.fn(), waiting = waitForCachedMessageDeletions("channel", "room").then(done);
  first(); const next = reserveCachedMessageDeletion("channel", "room");
  await Promise.resolve(); expect(done).not.toHaveBeenCalled();
  next(); await waiting; expect(done).toHaveBeenCalledOnce();
});

it.each(["owner", "generation"] as const)("rejects retired %s waits and keeps replacement reservations", async boundary => {
  const old = reserveCachedMessageDeletion("dm", "room");
  const retired = expect(waitForCachedMessageDeletions("dm", "room")).rejects.toThrow("e2ee_account_scope_changed");
  if (boundary === "owner") publishAuthOwnerChange("bob"); else publishAuthGenerationChange(++generation);
  const replacement = reserveCachedMessageDeletion("dm", "room");
  const done = vi.fn(), waiting = waitForCachedMessageDeletions("dm", "room").then(done);
  old(); await retired; expect(done).not.toHaveBeenCalled();
  replacement(); await waiting; expect(done).toHaveBeenCalledOnce();
});

it("cancels rapid-query waits without releasing an active deletion", async () => {
  const finish = reserveCachedMessageDeletion("channel", "room");
  for (let i = 0; i < 1000; i++) {
    const controller = new AbortController(), reason = new Error("query replaced");
    const waiting = waitForCachedMessageDeletions("channel", "room", controller.signal);
    controller.abort(reason); await expect(waiting).rejects.toBe(reason);
  }
  const done = vi.fn(), final = waitForCachedMessageDeletions("channel", "room").then(done);
  await Promise.resolve(); expect(done).not.toHaveBeenCalled();
  finish(); await final; expect(done).toHaveBeenCalledOnce();
});
