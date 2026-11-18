import {afterEach,beforeEach,expect,it} from "vitest";
import {usePreferencesStore} from "./preferencesStore";
import {bindPreferencePresenter} from "./preferencePresenter";
import {useSettingsStore} from "./settingsStore";
import {useSidebarStore} from "./sidebarStore";
import {APPEARANCE_DEFAULTS,APPEARANCE_STORAGE_KEYS} from "./appearancePreferences";

beforeEach(()=>{
  bindPreferencePresenter(async()=>()=>{});usePreferencesStore.getState().reset();localStorage.clear();
  usePreferencesStore.getState().bindAccount("alice");
  useSettingsStore.getState().applyAppearanceFromServer(APPEARANCE_DEFAULTS);
  useSettingsStore.getState().applyFromServer("midnight");
  useSidebarStore.getState().resetAccountPreferences();
});
afterEach(()=>{
  usePreferencesStore.getState().reset();
  bindPreferencePresenter(async()=>(await import("./applyAccountPreferences")).applyAccountPreferences);
});
const boundaries=["owner","backend","same-binding"] as const;
function replaceBinding(boundary:typeof boundaries[number]){
  if(boundary!=="same-binding")usePreferencesStore.getState().bindAccount(boundary==="owner"?"bob":"alice",boundary==="backend"?"https://replacement.example":undefined);
}
function queue(){
  const keys=Object.keys(localStorage).filter(key=>key.startsWith("hichat.preferences.pending.v1:"));
  // Retired accounts may legitimately retain their own queue. Only inspect
  // the current binding by matching its full cached data, also checked below.
  return keys.map(key=>JSON.parse(localStorage.getItem(key)!));
}
const settings=[
  {name:"theme",run:()=>useSettingsStore.getState().setTheme("ocean"),replace:()=>useSettingsStore.getState().setTheme("aurora"),expected:{theme:"aurora"},key:"mqvi_theme",value:"aurora"},
  {name:"blurEnabled",run:()=>useSettingsStore.getState().setBlurEnabled(false),replace:()=>useSettingsStore.getState().setBlurEnabled(true),expected:{appearance:{blurEnabled:true}},key:APPEARANCE_STORAGE_KEYS.blurEnabled,value:"1"},
  {name:"blurStrength",run:()=>useSettingsStore.getState().setBlurStrength(12),replace:()=>useSettingsStore.getState().setBlurStrength(24),expected:{appearance:{blurStrength:24}},key:APPEARANCE_STORAGE_KEYS.blurStrength,value:"24"},
  {name:"wallpaperEnabled",run:()=>useSettingsStore.getState().setWallpaperEnabled(false),replace:()=>useSettingsStore.getState().setWallpaperEnabled(true),expected:{appearance:{wallpaperEnabled:true}},key:APPEARANCE_STORAGE_KEYS.wallpaperEnabled,value:"1"},
  {name:"lightningEnabled",run:()=>useSettingsStore.getState().setLightningEnabled(false),replace:()=>useSettingsStore.getState().setLightningEnabled(true),expected:{appearance:{lightningEnabled:true}},key:APPEARANCE_STORAGE_KEYS.lightningEnabled,value:"1"},
  {name:"lightningBlur",run:()=>useSettingsStore.getState().setLightningBlur(8),replace:()=>useSettingsStore.getState().setLightningBlur(12),expected:{appearance:{lightningBlur:12}},key:APPEARANCE_STORAGE_KEYS.lightningBlur,value:"12"},
  {name:"neonEnabled",run:()=>useSettingsStore.getState().setNeonEnabled(false),replace:()=>useSettingsStore.getState().setNeonEnabled(true),expected:{appearance:{neonEnabled:true}},key:APPEARANCE_STORAGE_KEYS.neonEnabled,value:"1"},
  {name:"neonIntensity",run:()=>useSettingsStore.getState().setNeonIntensity(30),replace:()=>useSettingsStore.getState().setNeonIntensity(80),expected:{appearance:{neonIntensity:80}},key:APPEARANCE_STORAGE_KEYS.neonIntensity,value:"80"},
  {name:"uiScale",run:()=>useSettingsStore.getState().setUiScale(120),replace:()=>useSettingsStore.getState().setUiScale(150),expected:{appearance:{uiScale:150}},key:APPEARANCE_STORAGE_KEYS.uiScale,value:"150"},
  {name:"avatarAnimation",run:()=>useSettingsStore.getState().setAvatarAnimation("hover"),replace:()=>useSettingsStore.getState().setAvatarAnimation("always"),expected:{appearance:{avatarAnimation:"always"}},key:APPEARANCE_STORAGE_KEYS.avatarAnimation,value:"always"},
];
it.each(boundaries.flatMap(boundary=>settings.map(setting=>({...setting,boundary}))))("keeps newer $name queue after $boundary notification",test=>{
  let stop=()=>{};
  stop=useSettingsStore.subscribe(()=>{stop();replaceBinding(test.boundary);test.replace();});
  try{
    test.run();
    expect(usePreferencesStore.getState().data).toEqual(test.expected);
    expect(localStorage.getItem(test.key)).toBe(test.value);
    expect(queue()).toContainEqual(test.expected);
  }finally{stop();}
});

const sidebar=[
 {name:"toggle",setup:()=>useSidebarStore.getState().applyFromServer({},true),run:()=>useSidebarStore.getState().toggleSidebar(),expected:{sidebar_expanded:true},expanded:true},
 {name:"collapse",setup:()=>useSidebarStore.getState().applyFromServer({},true),run:()=>useSidebarStore.getState().collapseSidebar(),expected:{sidebar_expanded:true},expanded:true},
 {name:"expand",setup:()=>useSidebarStore.getState().applyFromServer({},false),run:()=>useSidebarStore.getState().expandSidebar(),expected:{sidebar_expanded:false},expanded:false},
 {name:"toggleSection",setup:()=>useSidebarStore.getState().applyFromServer({friends:true}),run:()=>useSidebarStore.getState().toggleSection("friends"),expected:{sidebar_sections:{friends:true}},expanded:true},
 {name:"expandSection",setup:()=>useSidebarStore.getState().applyFromServer({friends:false}),run:()=>useSidebarStore.getState().expandSection("friends"),expected:{sidebar_sections:{friends:false}},expanded:true},
];
it.each(boundaries.flatMap(boundary=>sidebar.flatMap(action=>(["destination","preferences"] as const).map(notification=>({...action,boundary,notification})))))("keeps replacement sidebar state during $name $notification notification ($boundary)",test=>{
  test.setup();
  let stop=()=>{};
  const replace=()=>{
    stop();replaceBinding(test.boundary);
    useSidebarStore.getState().applyFromServer(test.expected.sidebar_sections??{},test.expanded);
    usePreferencesStore.getState().set(test.expected);
  };
  stop=test.notification==="destination"?useSidebarStore.subscribe(replace):usePreferencesStore.subscribe(replace);
  try{
    test.run();
    expect(usePreferencesStore.getState().data).toEqual(test.expected);
    expect(useSidebarStore.getState().isExpanded).toBe(test.expanded);
    if(test.expected.sidebar_sections)expect(useSidebarStore.getState().expandedSections.friends).toBe(test.expected.sidebar_sections.friends);
    const cached=JSON.parse(localStorage.getItem("mqvi_sidebar")!);
    expect(cached.isExpanded).toBe(useSidebarStore.getState().isExpanded);
    expect(cached.expandedSections).toEqual(useSidebarStore.getState().expandedSections);
    expect(queue()).toContainEqual(test.expected);
  }finally{stop();}
});

it("keeps unrelated appearance edits from both nested setters",()=>{
  let stop=()=>{};
  stop=useSettingsStore.subscribe(()=>{stop();useSettingsStore.getState().setNeonIntensity(80);});
  try{
    useSettingsStore.getState().setUiScale(150);
    expect(usePreferencesStore.getState().data).toEqual({appearance:{uiScale:150,neonIntensity:80}});
  }finally{stop();}
});
it("keeps unrelated section edits from both nested sidebar actions",()=>{
  let stop=()=>{};
  stop=useSidebarStore.subscribe(()=>{stop();useSidebarStore.getState().toggleSection("dms");});
  try{
    useSidebarStore.getState().toggleSection("friends");
    expect(usePreferencesStore.getState().data).toEqual({sidebar_sections:{friends:false,dms:false}});
    expect(JSON.parse(localStorage.getItem("mqvi_sidebar")!).expandedSections).toMatchObject({friends:false,dms:false});
  }finally{stop();}
});
it.each(["expand","collapse","section"] as const)("preserves sidebar no-op behavior (%s)",mode=>{
  useSidebarStore.getState().applyFromServer({friends:true},mode!=="collapse");
  let notifications=0;
  const stop=useSidebarStore.subscribe(()=>{notifications++;});
  const cached=localStorage.getItem("mqvi_sidebar");
  try{
    const store=useSidebarStore.getState();
    if(mode==="expand")store.expandSidebar();
    else if(mode==="collapse")store.collapseSidebar();
    else store.expandSection("friends");
    expect(notifications).toBe(0);
    expect(localStorage.getItem("mqvi_sidebar")).toBe(cached);
    expect(usePreferencesStore.getState().data).toEqual({});
  }finally{stop();}
});
it("still materializes an explicitly expanded previously absent section",()=>{
  useSidebarStore.getState().expandSection("cat:missing");
  expect(useSidebarStore.getState().expandedSections["cat:missing"]).toBe(true);
  expect(usePreferencesStore.getState().data).toEqual({sidebar_sections:{"cat:missing":true}});
});
