import {beforeEach,expect,it,vi} from "vitest";
const h=vi.hoisted(()=>({owner:"owner",generation:1,device:"device",status:"online",valid:true,external:true,blocked:[] as string[],ignored:{} as Record<string,boolean>,focused:false,
  group:{id:"group",key_epoch:3,read_key_epoch:3,is_muted:false,read_revision:1,unread_count:1,last_read_source_sequence:"0",members:[{id:"owner"}]},
  destination:{type:"friends",channelId:"friends"},disposition:"allow",nowDisposition:"allow",receipt:undefined as unknown,handle:vi.fn(),markRead:vi.fn(),update:vi.fn(),policy:vi.fn(),show:vi.fn(),sound:vi.fn(),speak:vi.fn(),flash:vi.fn(),list:vi.fn(),open:vi.fn(),currentSound:false}));
vi.mock("../../api/client",()=>({getAuthGeneration:()=>h.generation}));
vi.mock("../../api/authSessionEvents",()=>({getAuthSessionSnapshot:()=>({ownerId:h.owner,generation:h.generation}),subscribeAuthOwnerChanges:()=>()=>{},subscribeAuthGenerationChanges:()=>()=>{}}));
vi.mock("../../i18n",()=>({default:{t:(key:string)=>key}}));
vi.mock("../../stores/authStore",()=>({useAuthStore:{getState:()=>({user:{id:h.owner},manualStatus:h.status})}}));
vi.mock("../../stores/groupDMStore",()=>({useGroupDMStore:{getState:()=>({ownerId:h.owner,authGeneration:h.generation,groups:[h.group],handleMessage:h.handle,markRead:h.markRead,handleCreateOrUpdate:h.update})}}));
vi.mock("../../stores/blockStore",()=>({useBlockStore:{getState:()=>({ownerId:h.owner,authGeneration:h.generation,snapshotReady:true,isLoading:false,blockedUserIds:h.blocked})}}));
vi.mock("../../stores/preferencesStore",()=>({usePreferencesStore:{getState:()=>({accountId:h.owner,isLoaded:true,get:()=>({ignoredUsers:h.ignored})})}}));
vi.mock("../../stores/e2eeStore",()=>({useE2EEStore:{getState:()=>({localDeviceId:h.device,initStatus:"ready",decryptionErrors:[]})}}));
vi.mock("../../stores/uiStore",()=>({useUIStore:{getState:()=>({destination:h.destination})}}));
vi.mock("../../stores/dmStore",()=>({useDMStore:{getState:()=>({})}}));
vi.mock("../../crypto/dmEncryption",()=>({decryptDMMessage:vi.fn(),popSentPlaintext:vi.fn(),popEditPlaintext:vi.fn()}));
vi.mock("../../crypto/dmMessageCache",()=>({cacheDMMessage:vi.fn(),readDMMessageCache:vi.fn()}));
vi.mock("../../crypto/dmMessageVersions",()=>({observeDMMessage:vi.fn()}));
vi.mock("../../crypto/keyStorage",()=>({deleteCachedDMMessage:vi.fn()}));
vi.mock("../../utils/groupDMPins",()=>({notifyGroupDMPinsChanged:vi.fn()}));
vi.mock("../../utils/messageSpamPolicy",()=>({getMessageSpamDisposition:()=>h.nowDisposition,resolveMessageSpamDisposition:(...args:unknown[])=>h.policy(...args)}));
vi.mock("../../utils/registerSpamMessage",()=>({registerSpamMessage:vi.fn()}));
vi.mock("../../utils/notificationPreferences",()=>({shouldFlashTaskbar:()=>true,getNotificationPreferences:()=>({currentChannelSound:h.currentSound})}));
vi.mock("../../utils/sounds",()=>({playNotificationSound:h.sound}));
vi.mock("../../utils/notifications",()=>({showNotification:h.show}));
vi.mock("../../utils/textToSpeech",()=>({speakIncomingMessage:h.speak}));
vi.mock("../../api/groupDM",()=>({listGroupDMs:h.list}));
vi.mock("../../utils/groupMessageNavigation",()=>({openGroupMessageAt:h.open}));
import {composerKey,useComposerDraftStore} from "../../stores/composerDraftStore";
import {handleDMEvent} from "./dmEventHandlers";
import type {GroupMessageAcceptance} from "../../stores/groupDMStore";
import type {GroupDMMessage} from "../../types/groupDM";
const message={id:"source",group_id:"group",user_id:"actor",content:"private body",key_epoch:3,source_sequence:"1",encryption_version:1,user:{username:"Author"}} as GroupDMMessage;
const event={op:"group_dm_message_create",d:message} as const;
function accepted(extra:Partial<Extract<GroupMessageAcceptance,{status:"accepted"}>>={}):GroupMessageAcceptance{return {status:"accepted",ownerId:"owner",authGeneration:1,deviceId:"device",groupId:"group",keyEpoch:3,messageId:"source",message,storage:"visible",previewReady:true,lifetime:1,sourceVersion:1,isCurrent:()=>h.valid,...extra};}
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(yes=>{resolve=yes;});return{promise,resolve};}
beforeEach(()=>{
 vi.clearAllMocks();h.owner="owner";h.generation=1;h.device="device";h.status="online";h.valid=true;h.external=true;h.blocked=[];h.ignored={};h.focused=false;h.destination={type:"friends",channelId:"friends"};h.disposition="allow";h.nowDisposition="allow";h.currentSound=false;
 h.group={id:"group",key_epoch:3,read_key_epoch:3,is_muted:false,read_revision:1,unread_count:1,last_read_source_sequence:"0",members:[{id:"owner"}]};
 h.handle.mockImplementation(async()=>accepted());h.policy.mockImplementation(async()=>h.disposition);h.list.mockResolvedValue({success:true,data:{group_dms:[h.group]}});h.open.mockResolvedValue(true);
 vi.spyOn(document,"hasFocus").mockImplementation(()=>h.focused);Object.defineProperty(document,"hidden",{configurable:true,value:false});Object.defineProperty(window,"electronAPI",{configurable:true,value:{flashFrame:h.flash}});
});
it("uses only an accepted receipt once for generic OS/sound/TTS cues without changing a draft",async()=>{
 h.handle.mockResolvedValueOnce(accepted()).mockResolvedValueOnce({status:"rejected"});await handleDMEvent(event);await handleDMEvent(event);
 expect(h.sound).toHaveBeenCalledOnce();expect(h.flash).toHaveBeenCalledOnce();expect(h.speak).toHaveBeenCalledWith("Author","private body");expect(h.show).toHaveBeenCalledOnce();
 expect(h.show.mock.calls[0][0]).toMatchObject({body:"inbox:kind.groupMessage",tag:"group:group"});expect(JSON.stringify(h.show.mock.calls[0])).not.toContain("private body");expect(h.markRead).not.toHaveBeenCalled();
});
it.each(["stale","external","blocked","ignored","muted","dnd","offline","invisible","device","epoch"])("suppresses all attention cues for %s",async reason=>{
 if(reason==="stale")h.valid=false;if(reason==="external")h.external=false;if(reason==="blocked")h.blocked=["actor"];if(reason==="ignored")h.ignored.actor=true;if(reason==="muted")h.group.is_muted=true;
 if(["dnd","offline","invisible"].includes(reason))h.status=reason;if(reason==="device")h.device="other";if(reason==="epoch")h.group.key_epoch=4;
 await handleDMEvent(event,()=>h.external);expect(h.show).not.toHaveBeenCalled();expect(h.sound).not.toHaveBeenCalled();expect(h.speak).not.toHaveBeenCalled();expect(h.flash).not.toHaveBeenCalled();
});
it("rechecks receipt/account/device after asynchronous policy before cues",async()=>{
 const pending=deferred<string>();h.policy.mockReturnValueOnce(pending.promise);const work=handleDMEvent(event);await vi.waitFor(()=>expect(h.policy).toHaveBeenCalled());h.generation=2;pending.resolve("allow");await work;
 expect(h.show).not.toHaveBeenCalled();expect(h.sound).not.toHaveBeenCalled();expect(h.speak).not.toHaveBeenCalled();
});
it("reads only a rendered allowed source in the foreground and honors current-channel sound",async()=>{
 h.destination={type:"group-dm",channelId:"group"};h.focused=true;await handleDMEvent(event);expect(h.markRead).toHaveBeenCalledExactlyOnceWith("group","source");expect(h.show).not.toHaveBeenCalled();expect(h.sound).not.toHaveBeenCalled();expect(h.flash).not.toHaveBeenCalled();
 h.currentSound=true;await handleDMEvent(event);expect(h.sound).toHaveBeenCalledOnce();
});
it.each(["pending","failed decrypt","detached"])("keeps %s generic and never reads or speaks it",async reason=>{
 if(reason==="pending"){h.disposition="pending";h.nowDisposition="pending";}else h.handle.mockResolvedValueOnce(accepted(reason==="detached"?{storage:"detached"}:{previewReady:false,message:{...message,content:null}}));
 await handleDMEvent(event);expect(h.show).toHaveBeenCalledOnce();expect(h.show.mock.calls[0][0].body).not.toContain("private body");expect(h.speak).not.toHaveBeenCalled();expect(h.markRead).not.toHaveBeenCalled();
});
it("filters spam without cues and does not treat selected but background group as read",async()=>{
 h.disposition="filter";h.nowDisposition="filter";await handleDMEvent(event);expect(h.show).not.toHaveBeenCalled();expect(h.sound).not.toHaveBeenCalled();
 h.disposition="allow";h.nowDisposition="allow";h.destination={type:"group-dm",channelId:"group"};await handleDMEvent(event);expect(h.markRead).not.toHaveBeenCalled();expect(h.show).toHaveBeenCalledOnce();
});
it.each(["read","mute","blocked","ignored","focus","rekey","deleted"])("withdraws delayed OS eligibility after %s",async reason=>{
 await handleDMEvent(event);const notice=h.show.mock.calls[0][0];expect(notice.isStillEligible()).toBe(true);
 if(reason==="read")h.group.last_read_source_sequence="1";if(reason==="mute")h.group.is_muted=true;if(reason==="blocked")h.blocked=["actor"];if(reason==="ignored")h.ignored.actor=true;
 if(reason==="focus"){h.focused=true;h.destination={type:"group-dm",channelId:"group"};}if(reason==="rekey")h.group.key_epoch=4;if(reason==="deleted")h.valid=false;
 expect(notice.isStillEligible()).toBe(false);
});
it("OS click refreshes membership then reuses exact-source navigation; stale permission cannot navigate",async()=>{
 await handleDMEvent(event);const notice=h.show.mock.calls[0][0];notice.onClick();await vi.waitFor(()=>expect(h.open).toHaveBeenCalledWith("group","source",expect.objectContaining({isCurrent:expect.any(Function)})));
 h.open.mockClear();h.list.mockResolvedValueOnce({success:true,data:{group_dms:[]}});notice.onClick();await vi.waitFor(()=>expect(h.list).toHaveBeenCalledTimes(2));expect(h.open).not.toHaveBeenCalled();
});

it("does not replay cues for a newly loaded source already below another session's read watermark",async()=>{
 h.group.last_read_source_sequence="1";await handleDMEvent(event);expect(h.show).not.toHaveBeenCalled();expect(h.sound).not.toHaveBeenCalled();expect(h.speak).not.toHaveBeenCalled();expect(h.flash).not.toHaveBeenCalled();
});

it("leaves a user's in-progress text/files untouched while incoming cues arrive",async()=>{
 const key=composerKey("owner","group","group"),files=[new File(["draft"],"draft.txt")];useComposerDraftStore.getState().patch(key,{content:"typing",files});
 await handleDMEvent(event);expect(useComposerDraftStore.getState().drafts[key]).toMatchObject({content:"typing",files});expect(h.open).not.toHaveBeenCalled();
});
it.each(["device","account","block","epoch"])("cancels OS click after %s changes while authoritative access is pending",async reason=>{
 await handleDMEvent(event);const notice=h.show.mock.calls[0][0],pending=deferred<unknown>();h.list.mockReturnValueOnce(pending.promise);notice.onClick();await vi.waitFor(()=>expect(h.list).toHaveBeenCalled());
 if(reason==="device")h.device="replacement";if(reason==="account")h.owner="other";if(reason==="block")h.blocked=["actor"];if(reason==="epoch")h.group.key_epoch=4;
 pending.resolve({success:true,data:{group_dms:[h.group]}});await Promise.resolve();await Promise.resolve();expect(h.open).not.toHaveBeenCalled();
});

it("an explicit delivered OS click still exact-jumps after the wrapper focuses an already-selected group",async()=>{
 h.destination={type:"group-dm",channelId:"group"};await handleDMEvent(event);const notice=h.show.mock.calls[0][0];h.focused=true;
 expect(notice.isStillEligible()).toBe(false);notice.onClick();await vi.waitFor(()=>expect(h.open).toHaveBeenCalledWith("group","source",expect.objectContaining({isCurrent:expect.any(Function)})));
});
