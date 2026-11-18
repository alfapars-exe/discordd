import { afterEach,beforeEach,expect,it } from "vitest";
import { usePreferencesStore } from "./preferencesStore";
import { bindPreferencePresenter } from "./preferencePresenter";
import { useAccessibilityStore } from "./accessibilityStore";
import { useTimeFormatStore } from "./timeFormatStore";
import { DEFAULT_ACCESSIBILITY } from "../styles/accessibility";

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

const cases=(["owner","backend","same-binding"] as const).flatMap(boundary=>(["accessibility","locale"] as const).flatMap(destination=>(["setter","hydrate","reset"] as const).map(operation=>({boundary,destination,operation}))));
it.each(cases)("does not write old $destination $operation effects after $boundary replacement",({boundary,destination,operation})=>{
  let stop=()=>{};
  const replace=()=>{
    stop();
    if(boundary!=="same-binding")usePreferencesStore.getState().bindAccount(boundary==="owner"?"bob":"alice",boundary==="backend"?"https://replacement.example":undefined);
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
    const queues=Object.keys(localStorage).filter(key=>key.startsWith("hichat.preferences.pending.v1:"));
    expect(queues).toHaveLength(1);
    expect(JSON.parse(localStorage.getItem(queues[0])!)).toEqual(destination==="accessibility"?{accessibility:{chatFontSize:22}}:{locale:{timeFormat:"24"}});
  }finally{stop();}
});

it("retains an outer setter leaf when a same-binding subscriber edits a different accessibility leaf",()=>{
  let stop=()=>{};
  stop=useAccessibilityStore.subscribe(()=>{stop();useAccessibilityStore.getState().setReduceMotion(true);});
  try {
    useAccessibilityStore.getState().setChatFontSize(20);
    expect(useAccessibilityStore.getState().chatFontSize).toBe(20);
    expect(useAccessibilityStore.getState().reduceMotion).toBe(true);
    expect(usePreferencesStore.getState().data.accessibility).toEqual({chatFontSize:20,reduceMotion:true});
    expect(JSON.parse(localStorage.getItem("tayfa.accessibility.v1")!)).toMatchObject({chatFontSize:20,reduceMotion:true});
  }finally{stop();}
});

it("keeps a newer leaf while still queueing the unaffected fields from an explicit accessibility reset",()=>{
  let stop=()=>{};
  stop=useAccessibilityStore.subscribe(()=>{stop();useAccessibilityStore.getState().setChatFontSize(22);});
  try {
    useAccessibilityStore.getState().reset();
    const expected={...DEFAULT_ACCESSIBILITY,chatFontSize:22};
    expect(usePreferencesStore.getState().data.accessibility).toEqual(expected);
    expect(JSON.parse(localStorage.getItem("tayfa.accessibility.v1")!)).toEqual(expected);
    expect(document.documentElement.style.getPropertyValue("--chat-font-size")).toBe("22px");
  }finally{stop();}
});
