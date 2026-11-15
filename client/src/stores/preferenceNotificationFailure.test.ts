import {afterEach,beforeEach,expect,it} from "vitest";
import {usePreferencesStore} from "./preferencesStore";
import {bindPreferencePresenter} from "./preferencePresenter";
import {useSettingsStore} from "./settingsStore";
import {useAccessibilityStore} from "./accessibilityStore";
import {useTimeFormatStore} from "./timeFormatStore";
import {useSidebarStore} from "./sidebarStore";
import {APPEARANCE_DEFAULTS} from "./appearancePreferences";
beforeEach(()=>{
  bindPreferencePresenter(async()=>()=>{});usePreferencesStore.getState().reset();localStorage.clear();
  usePreferencesStore.getState().bindAccount("alice");
  useSettingsStore.getState().applyAppearanceFromServer(APPEARANCE_DEFAULTS);
  useSettingsStore.getState().applyFromServer("midnight");
  useAccessibilityStore.getState().applyFromServer({chatFontSize:18});
  useTimeFormatStore.getState().applyFromServer({timeFormat:"12"});
  useSidebarStore.getState().resetAccountPreferences();
});
afterEach(()=>{
  usePreferencesStore.getState().reset();
  bindPreferencePresenter(async()=>(await import("./applyAccountPreferences")).applyAccountPreferences);
});
function pending(){
  const keys=Object.keys(localStorage).filter(key=>key.startsWith("hichat.preferences.pending.v1:"));
  return keys.map(key=>JSON.parse(localStorage.getItem(key)!));
}
const cases=[
 {name:"appearance",run:()=>useSettingsStore.getState().setUiScale(150),subscribe:useSettingsStore.subscribe,expected:{appearance:{uiScale:150}},key:"mqvi_ui_scale",cached:"150"},
 {name:"theme",run:()=>useSettingsStore.getState().setTheme("ocean"),subscribe:useSettingsStore.subscribe,expected:{theme:"ocean"},key:"mqvi_theme",cached:"ocean"},
 {name:"accessibility",run:()=>useAccessibilityStore.getState().setChatFontSize(20),subscribe:useAccessibilityStore.subscribe,expected:{accessibility:{chatFontSize:20}},key:"tayfa.accessibility.v1",cached:undefined},
 {name:"locale",run:()=>useTimeFormatStore.getState().setTimeFormat("24"),subscribe:useTimeFormatStore.subscribe,expected:{locale:{timeFormat:"24"}},key:"hichat.time-format.v1",cached:"24"},
 {name:"sidebar",run:()=>useSidebarStore.getState().collapseSidebar(),subscribe:useSidebarStore.subscribe,expected:{sidebar_expanded:false},key:"mqvi_sidebar",cached:undefined},
];
it.each(cases.flatMap(action=>(["destination","preferences"] as const).map(stage=>({...action,stage}))))("durably queues $name while preserving a $stage observer failure",test=>{
 const failure=new Error("observer failed");let stop=()=>{};
 const observer=()=>{stop();throw failure;};
 stop=test.stage==="destination"?test.subscribe(observer):usePreferencesStore.subscribe(observer);
 try{
  expect(test.run).toThrow(failure);
  expect(usePreferencesStore.getState().data).toEqual(test.expected);
  expect(usePreferencesStore.getState().hasPendingChanges).toBe(true);
  expect(pending()).toContainEqual(test.expected);
  if(test.cached!==undefined)expect(localStorage.getItem(test.key)).toBe(test.cached);
  if(test.name==="accessibility")expect(JSON.parse(localStorage.getItem(test.key)!).chatFontSize).toBe(20);
  if(test.name==="sidebar")expect(JSON.parse(localStorage.getItem(test.key)!).isExpanded).toBe(false);
 }finally{stop();}
});
it("preserves both failures if destination and preference observers throw",()=>{
 const first=new Error("destination failed"),second=new Error("preference observer failed");
 let stopFirst=()=>{},stopSecond=()=>{};
 stopFirst=useTimeFormatStore.subscribe(()=>{stopFirst();throw first;});
 stopSecond=usePreferencesStore.subscribe(()=>{stopSecond();throw second;});
 try{
  let thrown:unknown;
  try{useTimeFormatStore.getState().setTimeFormat("24");}catch(error){thrown=error;}
  expect(thrown).toBeInstanceOf(AggregateError);
  expect((thrown as AggregateError).errors).toEqual([first,second]);
  expect(pending()).toContainEqual({locale:{timeFormat:"24"}});
 }finally{stopFirst();stopSecond();}
});
it.each(["appearance","sidebar"] as const)("does not finish retired $name work after a replacing observer throws",name=>{
 const failure=new Error("retired observer failed");let stop=()=>{};
 const observer=()=>{
  stop();usePreferencesStore.getState().bindAccount("bob");
  useTimeFormatStore.getState().setTimeFormat("24");throw failure;
 };
 stop=name==="appearance"?useSettingsStore.subscribe(observer):useSidebarStore.subscribe(observer);
 try{
  const action=name==="appearance"?()=>useSettingsStore.getState().setUiScale(150):()=>useSidebarStore.getState().collapseSidebar();
  expect(action).toThrow(failure);
  expect(usePreferencesStore.getState().accountId).toBe("bob");
  expect(usePreferencesStore.getState().data).toEqual({locale:{timeFormat:"24"}});
  expect(pending()).toContainEqual({locale:{timeFormat:"24"}});
 }finally{stop();}
});

it.each([
 {name:"accessibility hydration",run:()=>useAccessibilityStore.getState().applyFromServer({chatFontSize:20}),subscribe:useAccessibilityStore.subscribe,key:"tayfa.accessibility.v1",value:20},
 {name:"accessibility reset",run:()=>useAccessibilityStore.getState().resetAccountPreferences(),subscribe:useAccessibilityStore.subscribe,key:"tayfa.accessibility.v1",value:16},
 {name:"locale hydration",run:()=>useTimeFormatStore.getState().applyFromServer({timeFormat:"24"}),subscribe:useTimeFormatStore.subscribe,key:"hichat.time-format.v1",value:"24"},
 {name:"locale reset",run:()=>useTimeFormatStore.getState().resetAccountPreferences(),subscribe:useTimeFormatStore.subscribe,key:"hichat.time-format.v1",value:"auto"},
])("completes $name caching without echo after an observer throws",test=>{
 const failure=new Error("hydration observer failed");let stop=()=>{};
 stop=test.subscribe(()=>{stop();throw failure;});
 try{
  expect(test.run).toThrow(failure);
  const raw=localStorage.getItem(test.key)!;
  expect(test.key==="tayfa.accessibility.v1"?JSON.parse(raw).chatFontSize:raw).toBe(test.value);
  expect(usePreferencesStore.getState().data).toEqual({});
  expect(pending()).toEqual([]);
 }finally{stop();}
});
