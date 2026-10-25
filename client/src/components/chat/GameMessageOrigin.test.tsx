import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import GameMessageOrigin from "./GameMessageOrigin";
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string, values?: { id: string }) => values ? `${key}: ${values.id}` : key }) }));
it("shows the server-stamped origin without implying verified publisher trust", () => {
  render(<GameMessageOrigin authorID="app1" applicationID="app1" />);
  expect(screen.getByText("gameMessageOrigin")).toHaveAttribute("title", "gameMessageOriginHint: app1");
});
it.each([undefined, null, "", "different-author"])("does not infer or misattribute an origin from %s", applicationID => {
  const { container } = render(<GameMessageOrigin authorID="app1" applicationID={applicationID} />);
  expect(container).toBeEmptyDOMElement();
});
