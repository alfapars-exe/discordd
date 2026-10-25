import{useUIStore}from "../stores/uiStore";
export function isPresentedVideoContext(channelId:string,type:"guild"|"group"|"p2p"){const state=useUIStore.getState(),panel=state.panels[state.activePanelId],tab=panel?.tabs.find(tab=>tab.id===panel.activeTabId);return !!tab&&(type==="guild"?(tab.type==="voice"||tab.type==="screen")&&tab.channelId===channelId:type==="group"?tab.type==="group-dm"&&tab.channelId===channelId:tab.type==="p2p")}
export const subscribeVideoPresentation=(changed:()=>void)=>useUIStore.subscribe(changed);
