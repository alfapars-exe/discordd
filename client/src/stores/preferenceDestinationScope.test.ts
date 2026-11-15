import { afterEach,beforeEach,expect,it } from "vitest";
import { usePreferencesStore } from "./preferencesStore";
import { bindPreferencePresenter } from "./preferencePresenter";
import { useAccessibilityStore } from "./accessibilityStore";
import { useTimeFormatStore } from "./timeFormatStore";

beforeEach(()=>{
  bindPreferencePresenter(async()=>()=>{});
  usePreferencesStore.getState().reset();localStorage.clear();
  usePreferencesStore.getState().bindAccount("alice");
  useAccessibilityStore.getState().applyFromServer({chatFontSize:18});
  useTimeFormatStore.getState().applyFromServer({timeFormat:"12"});
});
afterEach(()=>{
  usePreferencesStore.getState().reset();
  bindPreferencePresenter(async()=>(await import("./applyAccountPreferences")).applyAccountPreferences);
});

const cases=(["owner","backend"] as const).flatMap(boundary=>(["accessibility","locale"] as const).flatMap(destination=>(["setter","hydrate","reset"] as const).map(operation=>({boundary,destination,operation}))));
it.each(cases)("does not write old $destination $operation effects after $boundary replacement",({boundary,destination,operation})=>{
  let stop=()=>{};
  const replace=()=>{
    stop();
    usePreferencesStore.getState().bindAccount(boundary==="owner"?"bob":"alice",boundary==="backend"?"https://replacement.example":undefined);
    if(destination==="accessibility")useAccessibilityStore.getState().setChatFontSize(22);
    else useTimeFormatStore.getState().setTimeFormat("24");
  };
  stop=destination==="accessibility"?useAccessibilityStore.subscribe(replace):useTimeFormatStore.subscribe(replace);
  try {
    if(destination==="accessibility"){
      const store=useAccessibilityStore.getState();
      if(operation==="setter")store.setChatFontSize(20);
      else if(operation==="hydrate")store.applyFromServer({chatFontSize:20});
      else store.resetAccountPreferences();
      expect(useAccessibilityStore.getState().chatFontSize).toBe(22);
      expect(document.documentElement.style.getPropertyValue("--chat-font-size")).toBe("22px");
      expect(JSON.parse(localStorage.getItem("tayfa.accessibility.v1")!).chatFontSize).toBe(22);
      expect(usePreferencesStore.getState().data.accessibility).toEqual({chatFontSize:22});
    }else{
      const store=useTimeFormatStore.getState();
      if(operation==="setter")store.setTimeFormat("12");
      else if(operation==="hydrate")store.applyFromServer({timeFormat:"12"});
      else store.resetAccountPreferences();
      expect(useTimeFormatStore.getState().timeFormat).toBe("24");
      expect(localStorage.getItem("hichat.time-format.v1")).toBe("24");
      expect(usePreferencesStore.getState().data.locale).toEqual({timeFormat:"24"});
    }
    expect(usePreferencesStore.getState().accountId).toBe(boundary==="owner"?"bob":"alice");
    expect(usePreferencesStore.getState().hasPendingChanges).toBe(true);
  }finally{stop();}
});
