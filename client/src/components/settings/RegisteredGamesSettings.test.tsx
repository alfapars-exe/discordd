import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ElectronRegisteredGame, ElectronRegisteredGamesSnapshot } from "../../types/electron";
import RegisteredGamesSettings from "./RegisteredGamesSettings";

const { translate, createFeedbackTicket } = vi.hoisted(() => ({
  createFeedbackTicket: vi.fn(),
  translate: (key: string, options?: { date?: string }) => options?.date ? `${key} ${options.date}` : key,
}));
vi.mock("../../hooks/useConfirm", () => ({ useConfirm: () => async () => true }));
vi.mock("../../api/feedback", () => ({ createFeedbackTicket }));
vi.mock("react-i18next", async (importOriginal) => ({
  ...await importOriginal<typeof import("react-i18next")>(),
  useTranslation: () => ({ t: translate, i18n: { language: "en" } }),
}));

const game: ElectronRegisteredGame = {
  id: "12345678-1234-1234-1234-123456789012",
  displayName: "Sample Game",
  executableName: "sample.exe",
  shareAllowed: false,
  overlayAllowed: false,
  availability: "available",
  running: true,
  lastSeenAt: "2026-10-24T10:00:00.000Z",
};

function setApi(value: Partial<NonNullable<Window["electronAPI"]>> | undefined) {
  Object.defineProperty(window, "electronAPI", { configurable: true, value });
}

describe("RegisteredGamesSettings", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    createFeedbackTicket.mockReset();
    setApi(undefined);
  });

  it("explains that browser detection is unavailable instead of showing a fake empty list", async () => {
    render(<RegisteredGamesSettings />);
    expect(await screen.findByText("registeredGamesWebUnsupported")).toBeInTheDocument();
    expect(screen.queryByText("registeredGamesEmpty")).not.toBeInTheDocument();
  });

  it("shows local current/recent metadata and changes only the explicit local sharing permission", async () => {
    const setSharing = vi.fn().mockResolvedValue(true);
    setApi({
      getRegisteredGames: vi.fn().mockResolvedValue({ detection: "available", backgroundDetectionEnabled: false, games: [game] }),
      setRegisteredGameSharing: setSharing,
    });
    render(<RegisteredGamesSettings />);
    expect(await screen.findByText("Sample Game")).toBeInTheDocument();
    expect(screen.getByText(/registeredGamesRunning/)).toBeInTheDocument();
    expect(screen.getByText(/registeredGamesLastSeen/)).toBeInTheDocument();
    expect(screen.getByText(/registeredGamesShareNotice/)).toBeInTheDocument();
    const checkbox = screen.getByRole("checkbox");
    expect(checkbox).not.toBeChecked();
    fireEvent.click(checkbox);
    await waitFor(() => expect(setSharing).toHaveBeenCalledWith(game.id, true));
    expect(checkbox).toBeChecked();
  });

  it("associates the join adapter explicitly, without guessing from the executable or display name", async () => {
    const setAdapter = vi.fn().mockResolvedValue(true);
    setApi({ getRegisteredGames: vi.fn().mockResolvedValue({ detection: "available", backgroundDetectionEnabled: true, games: [game] }), setRegisteredGameJoinAdapter: setAdapter });
    render(<RegisteredGamesSettings />);
    const select = await screen.findByRole("combobox", { name: "cs2JoinAdapter" });
    expect(select).toHaveValue("none");
    fireEvent.change(select, { target: { value: "cs2-steam" } });
    await waitFor(() => expect(setAdapter).toHaveBeenCalledWith(game.id, "cs2-steam"));
    expect(select).toHaveValue("cs2-steam");
    expect(screen.getByRole("button", { name: "cs2OfferShare" })).toBeDisabled(); // game is not shared
  });

  it("changes the local foreground-overlay opt-in independently from game-activity sharing", async () => {
    const setSharing = vi.fn().mockResolvedValue(true);
    const setRegisteredGameOverlay = vi.fn().mockResolvedValue(true);
    setApi({
      getRegisteredGames: vi.fn().mockResolvedValue({ detection: "available", overlaySupport: "available", backgroundDetectionEnabled: false, games: [game] }),
      setRegisteredGamesBackgroundDetection: vi.fn(),
      setRegisteredGameSharing: setSharing,
      setRegisteredGameOverlay,
    });
    render(<RegisteredGamesSettings />);
    const overlayToggle = await screen.findByRole("checkbox", { name: "registeredGamesOverlayOptIn" });
    expect(overlayToggle).not.toBeChecked();
    expect(screen.getByText("registeredGamesOverlayDescription")).toBeInTheDocument();
    expect(screen.getByText("registeredGamesOverlaySupportAvailable")).toBeInTheDocument();
    fireEvent.click(overlayToggle);
    await waitFor(() => expect(setRegisteredGameOverlay).toHaveBeenCalledWith(game.id, true));
    expect(overlayToggle).toBeChecked();
    expect(setSharing).not.toHaveBeenCalled();
  });

  it("opens the existing feedback form and submits only user-entered issue text", async () => {
    createFeedbackTicket.mockResolvedValue({ success: true });
    setApi({
      getRegisteredGames: vi.fn().mockResolvedValue({ detection: "available", overlaySupport: "unavailable", backgroundDetectionEnabled: false, games: [game] }),
      setRegisteredGameOverlay: vi.fn(),
    });
    render(<RegisteredGamesSettings />);
    expect(await screen.findByText("registeredGamesOverlaySupportUnavailable")).toBeInTheDocument();
    expect(screen.getByText("registeredGamesReportIssueDescription")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "registeredGamesReportIssue" }));
    fireEvent.change(screen.getByPlaceholderText("feedbackSubjectPlaceholder"), { target: { value: "Game overlay does not appear" } });
    fireEvent.change(screen.getByPlaceholderText("feedbackContentPlaceholder"), { target: { value: "The opted-in foreground game window does not show the voice widget." } });
    fireEvent.click(screen.getByRole("button", { name: "feedbackSubmit" }));
    await waitFor(() => expect(createFeedbackTicket).toHaveBeenCalledWith({
      type: "bug",
      subject: "Game overlay does not appear",
      content: "The opted-in foreground game window does not show the voice widget.",
      files: undefined,
    }));
    expect(await screen.findByRole("button", { name: "registeredGamesReportIssue" })).toBeInTheDocument();
  });

  it("keeps local permission configurable but warns when the helper is unavailable", async () => {
    const setRegisteredGameOverlay = vi.fn().mockResolvedValue(true);
    setApi({
      getRegisteredGames: vi.fn().mockResolvedValue({ detection: "available", overlaySupport: "unavailable", backgroundDetectionEnabled: false, games: [game] }),
      setRegisteredGameOverlay,
    });
    render(<RegisteredGamesSettings />);
    const overlayToggle = await screen.findByRole("checkbox", { name: "registeredGamesOverlayOptIn" });
    expect(screen.getByText("registeredGamesOverlaySupportUnavailable")).toBeInTheDocument();
    fireEvent.click(overlayToggle);
    await waitFor(() => expect(setRegisteredGameOverlay).toHaveBeenCalledWith(game.id, true));
    expect(overlayToggle).toBeChecked();
  });

  it.each([
    ["unsupported", "registeredGamesOverlaySupportUnsupported"],
    [undefined, "registeredGamesOverlaySupportUnknown"],
  ] as const)("shows a fail-closed overlay support notice for %s helper status", async (overlaySupport, notice) => {
    setApi({
      getRegisteredGames: vi.fn().mockResolvedValue({ detection: "available", overlaySupport, backgroundDetectionEnabled: false, games: [game] }),
      setRegisteredGameOverlay: vi.fn(),
    });
    render(<RegisteredGamesSettings />);
    expect(await screen.findByText(notice)).toBeInTheDocument();
  });

  it("does not claim a game overlay opt-in was saved when the bridge rejects it", async () => {
    setApi({
      getRegisteredGames: vi.fn().mockResolvedValue({ detection: "available", backgroundDetectionEnabled: false, games: [game] }),
      setRegisteredGameOverlay: vi.fn().mockResolvedValue(false),
    });
    render(<RegisteredGamesSettings />);
    const overlayToggle = await screen.findByRole("checkbox", { name: "registeredGamesOverlayOptIn" });
    fireEvent.click(overlayToggle);
    expect(await screen.findByRole("alert")).toHaveTextContent("registeredGamesSaveError");
    expect(overlayToggle).not.toBeChecked();
  });

  it("adds a game only through the main-process picker and refreshes the registry", async () => {
    const getRegisteredGames = vi.fn()
      .mockResolvedValueOnce({ detection: "available", backgroundDetectionEnabled: false, games: [] })
      .mockResolvedValueOnce({ detection: "available", backgroundDetectionEnabled: false, games: [game] });
    const addRegisteredGame = vi.fn().mockResolvedValue(game);
    setApi({ getRegisteredGames, addRegisteredGame });
    render(<RegisteredGamesSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "registeredGamesAdd" }));
    await waitFor(() => expect(addRegisteredGame).toHaveBeenCalledWith());
    expect(await screen.findByText("Sample Game")).toBeInTheDocument();
    expect(getRegisteredGames).toHaveBeenCalledTimes(2);
  });

  it("does not let an older poll restore a game after a confirmed removal", async () => {
    let resolvePoll!: (snapshot: ElectronRegisteredGamesSnapshot) => void;
    const delayedPoll = new Promise<ElectronRegisteredGamesSnapshot>((resolve) => { resolvePoll = resolve; });
    const removeRegisteredGame = vi.fn().mockResolvedValue(true);
    const getRegisteredGames = vi.fn()
      .mockResolvedValueOnce({ detection: "available", backgroundDetectionEnabled: false, games: [game] })
      .mockReturnValueOnce(delayedPoll);
    setApi({ getRegisteredGames, removeRegisteredGame });
    render(<RegisteredGamesSettings />);
    expect(await screen.findByText("Sample Game")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "registeredGamesRetry" }));
    await waitFor(() => expect(getRegisteredGames).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: "registeredGamesRemove" }));
    await waitFor(() => expect(removeRegisteredGame).toHaveBeenCalledWith(game.id));
    await waitFor(() => expect(screen.queryByText("Sample Game")).not.toBeInTheDocument());
    resolvePoll({ detection: "available", backgroundDetectionEnabled: false, games: [game] });
    await Promise.resolve();
    expect(screen.queryByText("Sample Game")).not.toBeInTheDocument();
  });

  it("keeps a missing executable registered and explains how to recover it", async () => {
    setApi({
      getRegisteredGames: vi.fn().mockResolvedValue({
        detection: "available",
        games: [{ ...game, availability: "missing", running: null }],
      }),
    });
    render(<RegisteredGamesSettings />);
    expect(await screen.findByText(/registeredGamesFileMissing/)).toBeInTheDocument();
    expect(screen.getByText(/registeredGamesFileRecovery/)).toBeInTheDocument();
    expect(screen.getByText("registeredGamesRecent")).toBeInTheDocument();
    expect(screen.getByText("registeredGamesCurrent")).toBeInTheDocument();
    expect(screen.queryByText(/registeredGamesNotRunning/)).not.toBeInTheDocument();
  });

  it("persists the explicit background-detection choice and reflects failures honestly", async () => {
    const setBackground = vi.fn().mockResolvedValueOnce(true).mockRejectedValueOnce(new Error("write failed"));
    setApi({
      getRegisteredGames: vi.fn().mockResolvedValue({ detection: "available", backgroundDetectionEnabled: false, games: [] }),
      setRegisteredGamesBackgroundDetection: setBackground,
    });
    render(<RegisteredGamesSettings />);
    const backgroundToggle = await screen.findByRole("checkbox", { name: /registeredGamesBackgroundDetection/ });
    fireEvent.click(backgroundToggle);
    await waitFor(() => expect(setBackground).toHaveBeenLastCalledWith(true));
    expect(backgroundToggle).toBeChecked();
    fireEvent.click(backgroundToggle);
    await waitFor(() => expect(setBackground).toHaveBeenLastCalledWith(false));
    expect(await screen.findByRole("alert")).toHaveTextContent("registeredGamesSaveError");
    expect(backgroundToggle).toBeChecked();
  });
});

it("orders actual recent timestamps newest first and separates never-seen added records",async()=>{
 setApi({getRegisteredGames:vi.fn().mockResolvedValue({detection:"available",backgroundDetectionEnabled:false,games:[{...game,id:"old",displayName:"Older",running:false,lastSeenAt:"2026-10-20T10:00:00Z"},{...game,id:"never",displayName:"Unseen",running:false,lastSeenAt:null},{...game,id:"new",displayName:"Newest",running:false,lastSeenAt:"2026-10-25T10:00:00Z"}]})});render(<RegisteredGamesSettings/>);await screen.findByText("Newest");
 const recent=screen.getByText("registeredGamesRecent").parentElement!;expect(within(recent).getAllByRole("region").map(node=>node.getAttribute("aria-label"))).toEqual(["Newest","Older"]);expect(within(recent).queryByText("Unseen")).toBeNull();expect(within(screen.getByText("registeredGamesAddedUnseen").parentElement!).getByText("Unseen")).toBeInTheDocument();
});
it("keeps a failed name draft for retry and publishes only the saved display name",async()=>{
 const rename=vi.fn().mockRejectedValueOnce(new Error("disk")).mockResolvedValueOnce(true);setApi({getRegisteredGames:vi.fn().mockResolvedValue({detection:"available",games:[game]}),setRegisteredGameName:rename});render(<RegisteredGamesSettings/>);fireEvent.click(await screen.findByRole("button",{name:"registeredGamesRename"}));const input=screen.getByRole("textbox",{name:"registeredGamesName"});fireEvent.change(input,{target:{value:"New title"}});fireEvent.click(screen.getByRole("button",{name:"registeredGamesNameSave"}));expect(await screen.findByRole("alert")).toHaveTextContent("registeredGamesSaveError");expect(input).toHaveValue("New title");expect(screen.getByText("Sample Game")).toBeInTheDocument();fireEvent.click(screen.getByRole("button",{name:"registeredGamesNameSave"}));await screen.findByText("New title");expect(rename).toHaveBeenLastCalledWith(game.id,"New title");expect(screen.queryByRole("textbox")).toBeNull();expect(screen.queryByText("Sample Game")).toBeNull();
});

it("explains invalid names and never silently submits path/control/empty/overlong drafts",async()=>{
 const rename=vi.fn();setApi({getRegisteredGames:vi.fn().mockResolvedValue({detection:"available",games:[game]}),setRegisteredGameName:rename});render(<RegisteredGamesSettings/>);fireEvent.click(await screen.findByRole("button",{name:"registeredGamesRename"}));const input=screen.getByRole("textbox",{name:"registeredGamesName"});
 for(const value of ["   ","C:/Games/game.exe","bad\tname"," "+"x".repeat(80)+" "]){fireEvent.change(input,{target:{value}});expect(input).toHaveAttribute("aria-invalid","true");expect(screen.getByText("registeredGamesNameInvalid")).toBeInTheDocument();expect(screen.getByRole("button",{name:"registeredGamesNameSave"})).toBeDisabled()}
 expect(rename).not.toHaveBeenCalled();fireEvent.change(input,{target:{value:"Good name"}});expect(input).toHaveAttribute("aria-invalid","false");expect(screen.queryByText("registeredGamesNameInvalid")).toBeNull();expect(screen.getByRole("button",{name:"registeredGamesNameSave"})).toBeEnabled();fireEvent.click(screen.getByRole("button",{name:"registeredGamesNameCancel"}));expect(screen.queryByRole("textbox")).toBeNull();expect(rename).not.toHaveBeenCalled();
});
