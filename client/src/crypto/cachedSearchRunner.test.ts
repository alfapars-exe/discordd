import { beforeEach, expect, it, vi } from "vitest";
import { runCachedSearch, type CachedSearchPage } from "./cachedSearchRunner";
import { createCachedSearchSnapshot } from "./cachedSearchSnapshot";
import { readCachedSearchPage } from "./cachedSearchPage";
import { fakeCachedSearchSnapshot } from "../test/fakeCachedSearchSnapshot";
import { fakeCachedSearchDeletionPool } from "../test/fakeCachedSearchDeletionPool";
vi.mock("./cachedSearchSnapshot", () => ({ createCachedSearchSnapshot: vi.fn() }));
vi.mock("./cachedSearchPage", () => ({ readCachedSearchPage: vi.fn() }));
beforeEach(() => { vi.resetAllMocks(); });
const page: CachedSearchPage = { messages: [], offset: 0, total: 0 };
function fixture() {
  const snapshot = fakeCachedSearchSnapshot("channel", []), pool = fakeCachedSearchDeletionPool();
  const frontier = pool.create(() => {});
  const request: Parameters<typeof runCachedSearch>[0] = {
    kind: "channel", channelId: "channel", query: " MATCH ", offset: 0, limit: 25,
    controller: { current: null }, snapshot: { current: snapshot }, deletions: { current: frontier },
    getPool: vi.fn(async () => pool), startFrontier: vi.fn(() => frontier),
    matches: vi.fn(() => true), isCurrent: vi.fn(() => true), publish: vi.fn(), fail: vi.fn(), finish: vi.fn(),
  };
  vi.mocked(readCachedSearchPage).mockResolvedValue(page);
  return { request, snapshot, pool, frontier };
}
it("publishes and finishes in the page continuation before its caller resumes", async () => {
  const { request } = fixture(), events: string[] = [];
  request.publish = () => { events.push("publish"); queueMicrotask(() => events.push("after-publish")); };
  request.finish = () => events.push("finish");
  await runCachedSearch(request);
  expect(events).toEqual(["publish", "finish", "after-publish"]);
  expect(request.fail).not.toHaveBeenCalled();
});
it("does not create a frontier or snapshot when ownership retires during pool opening", async () => {
  const { request, pool } = fixture();
  let ready!: (value: typeof pool) => void;
  request.snapshot.current = null; request.deletions.current = null;
  request.getPool = () => new Promise(resolve => { ready = resolve; });
  const pending = runCachedSearch(request);
  vi.mocked(request.isCurrent).mockReturnValue(false); ready(pool);
  await pending;
  expect(request.startFrontier).not.toHaveBeenCalled();
  expect(createCachedSearchSnapshot).not.toHaveBeenCalled();
  expect(request.publish).not.toHaveBeenCalled(); expect(request.finish).not.toHaveBeenCalled();
});
it("disposes a late snapshot without attaching it to the retired query", async () => {
  const { request, snapshot } = fixture(); request.snapshot.current = null;
  let ready!: (value: typeof snapshot) => void;
  vi.mocked(createCachedSearchSnapshot).mockReturnValue(new Promise(resolve => { ready = resolve; }));
  const dispose = vi.spyOn(snapshot, "dispose"), pending = runCachedSearch(request);
  await vi.waitFor(() => expect(createCachedSearchSnapshot).toHaveBeenCalled());
  vi.mocked(request.isCurrent).mockReturnValue(false); ready(snapshot); await pending;
  expect(dispose).toHaveBeenCalledOnce(); expect(request.snapshot.current).toBeNull();
  expect(request.publish).not.toHaveBeenCalled(); expect(request.finish).not.toHaveBeenCalled();
});
it("drains a tombstone received during hydration and retries before publication", async () => {
  const { request, frontier, snapshot } = fixture(), stale = { ...page, total: 1 };
  const remove = vi.spyOn(snapshot, "removeMany");
  vi.mocked(readCachedSearchPage).mockImplementationOnce(async () => { frontier.append("deleted"); return stale; });
  await runCachedSearch(request);
  expect(readCachedSearchPage).toHaveBeenCalledTimes(2);
  expect(remove).toHaveBeenCalledWith(["deleted"], expect.any(AbortSignal));
  expect(request.publish).toHaveBeenCalledExactlyOnceWith(page);
});
it.each([true, false])("reports storage failure only for a current owner (%s)", async current => {
  const { request } = fixture();
  vi.mocked(readCachedSearchPage).mockImplementationOnce(async () => {
    vi.mocked(request.isCurrent).mockReturnValue(current); throw new Error("storage failed");
  });
  await runCachedSearch(request);
  expect(request.fail).toHaveBeenCalledTimes(Number(current));
  expect(request.finish).toHaveBeenCalledTimes(Number(current));
  expect(request.publish).not.toHaveBeenCalled();
});
