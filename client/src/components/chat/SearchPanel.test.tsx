/**
 * SearchPanel race regression tests (QA 2026-05-28 bug #6):
 *
 *   1. Out-of-order responses — a slow response for an abandoned query
 *      resolving AFTER the newer one must not clobber the newer results.
 *   2. Live deletion — a WS delete (messageStore.lastDeleted) while the
 *      panel is open removes the matching row from the result snapshot.
 *   3. Result click — onSelectResult resolving false (message gone on the
 *      server) drops the row WITHOUT a panel toast (the navigator toasts —
 *      one toast only); true leaves the snapshot alone.
 *
 * The real stores pull in the full crypto/i18n import graph, so every
 * store the panel touches is mocked with a minimal REAL zustand store —
 * selector subscriptions behave exactly like production, without the
 * import weight. Pattern matches memberStore.test.ts (mock the API
 * module, drive state through the store, assert on the rendered output).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";

vi.mock("react-i18next", () => ({ useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en" },
  }), initReactI18next: { type: "3rdParty", init: () => {} } }));

vi.mock("../../api/search", () => ({
  searchMessages: vi.fn(),
}));

vi.mock("../../crypto/keyStorage", () => ({
  searchCachedMessages: vi.fn(async () => []),
}));

// e2ee disabled + not ready -> the panel takes the server-side FTS5 path.
vi.mock("../../stores/serverStore", async () => {
  const { create } = await vi.importActual<typeof import("zustand")>("zustand");
  return {
    useServerStore: create(() => ({
      activeServerId: "srv-1",
      activeServer: { e2ee_enabled: false },
    })),
  };
});

vi.mock("../../stores/e2eeStore", async () => {
  const { create } = await vi.importActual<typeof import("zustand")>("zustand");
  return {
    useE2EEStore: create(() => ({ initStatus: "uninitialized" })),
  };
});

vi.mock("../../stores/messageStore", async () => {
  const { create } = await vi.importActual<typeof import("zustand")>("zustand");
  return {
    useMessageStore: create(() => ({
      messagesByChannel: {},
      lastDeleted: null as { id: string; channel_id: string } | null,
    })),
  };
});

vi.mock("../../stores/toastStore", async () => {
  const { create } = await vi.importActual<typeof import("zustand")>("zustand");
  return {
    useToastStore: create(() => ({ addToast: vi.fn() })),
  };
});

vi.mock("../shared/Avatar", () => ({
  default: () => null,
}));

import SearchPanel from "./SearchPanel";
import { searchMessages } from "../../api/search";
import { useMessageStore } from "../../stores/messageStore";
import { useToastStore } from "../../stores/toastStore";
import type { SearchResult } from "../../api/search";
import type { APIResponse, Message } from "../../types";

/** Same minimal Message shape SearchPanel itself builds for E2EE results. */
function makeMessage(id: string, content: string): Message {
  return {
    id,
    channel_id: "ch-1",
    user_id: "",
    content,
    created_at: "2026-01-01T00:00:00.000Z",
    edited_at: null,
    attachments: [],
    mentions: [],
    role_mentions: [],
    reactions: [],
    reply_to_id: null,
    referenced_message: null,
    author: { id: "", username: "qa", display_name: null, avatar_url: null, status: "offline" as const, custom_status: null, created_at: "" },
    encryption_version: 1,
  };
}

/** Manually-resolvable promise — lets the test control response order. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function ok(messages: Message[]): APIResponse<SearchResult> {
  return { success: true, data: { messages, total_count: messages.length } };
}

/** Type into the search box and advance past the 300ms debounce. */
function typeQuery(value: string) {
  const input = screen.getByPlaceholderText("searchPlaceholder");
  fireEvent.change(input, { target: { value } });
  act(() => {
    vi.advanceTimersByTime(300);
  });
}

describe("SearchPanel — result races", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(searchMessages).mockReset();
    useMessageStore.setState({ lastDeleted: null });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("ignores an older response that resolves after a newer one", async () => {
    const older = deferred<APIResponse<SearchResult>>();
    const newer = deferred<APIResponse<SearchResult>>();
    vi.mocked(searchMessages)
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);

    render(<SearchPanel onClose={() => {}} />);

    typeQuery("first");
    typeQuery("second");
    expect(vi.mocked(searchMessages)).toHaveBeenCalledTimes(2);

    // Newer request resolves first…
    await act(async () => {
      newer.resolve(ok([makeMessage("m-new", "newer result")]));
    });
    expect(screen.getByText("newer result")).toBeInTheDocument();

    // …then the stale one — it must not clobber the newer results.
    await act(async () => {
      older.resolve(ok([makeMessage("m-old", "older result")]));
    });
    expect(screen.queryByText("older result")).not.toBeInTheDocument();
    expect(screen.getByText("newer result")).toBeInTheDocument();
  });

  it("drops a result row when messageStore reports its live deletion", async () => {
    vi.mocked(searchMessages).mockResolvedValueOnce(
      ok([makeMessage("m-x", "doomed row"), makeMessage("m-y", "surviving row")])
    );

    render(<SearchPanel onClose={() => {}} />);
    typeQuery("row");

    // Flush the resolved search promise.
    await act(async () => {});
    expect(screen.getByText("doomed row")).toBeInTheDocument();
    expect(screen.getByText("surviving row")).toBeInTheDocument();

    // WS delete arrives while the panel is open.
    act(() => {
      useMessageStore.setState({ lastDeleted: { id: "m-x", channel_id: "ch-1" } });
    });

    expect(screen.queryByText("doomed row")).not.toBeInTheDocument();
    expect(screen.getByText("surviving row")).toBeInTheDocument();
  });
});

describe("SearchPanel — result click", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(searchMessages).mockReset();
    vi.mocked(useToastStore.getState().addToast).mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("drops the row (no duplicate panel toast) when navigation reports the message gone", async () => {
    vi.mocked(searchMessages).mockResolvedValueOnce(
      ok([makeMessage("m-gone", "gone row"), makeMessage("m-ok", "kept row")])
    );
    const onSelectResult = vi.fn(async (m: Message) => m.id !== "m-gone");

    render(<SearchPanel channelId="ch-1" onClose={() => {}} onSelectResult={onSelectResult} />);
    typeQuery("row");
    await act(async () => {});

    await act(async () => {
      fireEvent.click(screen.getByText("gone row"));
    });
    expect(onSelectResult).toHaveBeenCalledWith(expect.objectContaining({ id: "m-gone" }));
    expect(screen.queryByText("gone row")).not.toBeInTheDocument();
    expect(screen.getByText("kept row")).toBeInTheDocument();

    // A successful navigation leaves the snapshot untouched.
    await act(async () => {
      fireEvent.click(screen.getByText("kept row"));
    });
    expect(screen.getByText("kept row")).toBeInTheDocument();
    // The panel itself never toasts — useOpenAtMessage owns that message.
    expect(useToastStore.getState().addToast).not.toHaveBeenCalled();
  });
});
