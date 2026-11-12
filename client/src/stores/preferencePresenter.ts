import type { applyAccountPreferences } from "./applyAccountPreferences";

type LoadPresenter = () => Promise<typeof applyAccountPreferences>;
let load: LoadPresenter | undefined;

export function bindPreferencePresenter(loader: LoadPresenter): void {
  load = loader;
}

export function loadPreferencePresenter(): Promise<typeof applyAccountPreferences> {
  if (!load) throw new Error("Account preference presentation has not been initialized");
  return load();
}
