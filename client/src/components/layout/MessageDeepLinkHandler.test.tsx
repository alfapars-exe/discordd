import { StrictMode } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useServerStore } from "../../stores/serverStore";
import MessageDeepLinkHandler from "./MessageDeepLinkHandler";

const openAtMessage = vi.fn(async () => true);
const openAtDMMessage = vi.fn(async () => true);

vi.mock("../../hooks/useOpenAtMessage", () => ({
  useOpenAtMessage: () => ({ openAtMessage, openAtDMMessage }),
}));

function LocationProbe() {
  return <output data-testid="location">{useLocation().pathname}</output>;
}

function renderRoute(path: string) {
  return render(
    <StrictMode>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/channels/*" element={<><MessageDeepLinkHandler /><LocationProbe /></>} />
        </Routes>
      </MemoryRouter>
    </StrictMode>,
  );
}

describe("MessageDeepLinkHandler", () => {
  beforeEach(() => {
    openAtMessage.mockClear();
    openAtDMMessage.mockClear();
    useServerStore.setState({ servers: [], activeServerId: null, activeServer: null, isLoading: false });
  });

  it("opens a DM link once under StrictMode and replaces the URL", async () => {
    renderRoute("/channels/message/dm/dm-1/msg-2");
    await waitFor(() => expect(openAtDMMessage).toHaveBeenCalledWith("dm-1", "msg-2"));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/channels"));
    expect(openAtDMMessage).toHaveBeenCalledTimes(1);
  });

  it("waits for server membership before switching and opening", async () => {
    renderRoute("/channels/message/server/server-1/channel-2/msg-3");
    expect(openAtMessage).not.toHaveBeenCalled();

    useServerStore.setState({
      servers: [{ id: "server-1", name: "Test", icon_url: null }],
    });

    await waitFor(() => expect(openAtMessage).toHaveBeenCalledWith("server-1", "channel-2", "msg-3"));
    expect(useServerStore.getState().activeServerId).toBe("server-1");
  });
});
