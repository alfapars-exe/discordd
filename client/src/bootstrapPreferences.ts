import { bindPreferencePresenter } from "./stores/preferencePresenter";

bindPreferencePresenter(async () => (await import("./stores/applyAccountPreferences")).applyAccountPreferences);
