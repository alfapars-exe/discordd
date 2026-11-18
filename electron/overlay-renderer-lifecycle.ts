import type { App, WebContents } from "electron";

type RendererLifecycle = {
  app: Pick<App, "on" | "removeListener">;
  mainContents: () => WebContents | null;
  retire: (contents: WebContents) => void;
  revokeMain: () => void;
};

/** Own only overlay renderer listeners; siblings retain their own subscriptions. */
export function observeOverlayRenderers(operations: RendererLifecycle): () => void {
  let disposed = false;
  const tracked = new Map<WebContents, () => void>();
  const created = (_event: unknown, contents: WebContents) => {
    if (disposed || tracked.has(contents)) return;
    let active = true;
    const detach = () => {
      active = false;
      contents.removeListener("destroyed", destroyed);
      contents.removeListener("render-process-gone", crashed);
      contents.removeListener("did-start-navigation", navigating);
      tracked.delete(contents);
    };
    const destroyed = () => {
      if (!active || disposed) return;
      detach();
      operations.retire(contents);
    };
    const crashed = () => {
      if (active && !disposed && operations.mainContents() === contents) operations.revokeMain();
    };
    const navigating = (_navigationEvent: unknown, _url: string, inPlace: boolean, mainFrame: boolean) => {
      if (mainFrame && !inPlace) crashed();
    };
    tracked.set(contents, detach);
    contents.on("destroyed", destroyed);
    contents.on("render-process-gone", crashed);
    contents.on("did-start-navigation", navigating);
  };
  operations.app.on("web-contents-created", created);
  return () => {
    if (disposed) return;
    disposed = true;
    operations.app.removeListener("web-contents-created", created);
    for (const detach of [...tracked.values()]) detach();
  };
}
