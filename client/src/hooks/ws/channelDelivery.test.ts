import { beforeEach, expect, it, vi } from "vitest";
import type { WSMessage } from "../../types";
const api=vi.hoisted(()=>vi.fn());
vi.mock("../../api/client",()=>({apiClient:api,getAuthGeneration:()=>1}));
vi.mock("../../api/authSessionEvents",()=>({getAuthSessionOwner:()=>"owner",subscribeAuthOwnerChanges:vi.fn(),subscribeAuthGenerationChanges:vi.fn()}));
import {dispatchChannelDelivery,resyncChannelDelivery} from "./channelDelivery";
beforeEach(()=>api.mockReset());
it("dedupes retries and rejects an older version of the same message",async()=>{
 const apply=vi.fn().mockResolvedValue(undefined);const m={op:"message_update",event_id:"two",channel_sequence:2,d:{channel_id:"dedupe",id:"message"}} as WSMessage;
 await dispatchChannelDelivery(m,apply,()=>true);await dispatchChannelDelivery(m,apply,()=>true);await dispatchChannelDelivery({...m,event_id:"one",channel_sequence:1},apply,()=>true);expect(apply).toHaveBeenCalledTimes(1);
});
it("serializes async decrypt work within a channel",async()=>{
 const order:number[]=[];let finish!:()=>void;
 const a=dispatchChannelDelivery({op:"message_create",event_id:"a",channel_sequence:1,d:{channel_id:"serial",id:"message"}} as WSMessage,()=>new Promise<void>(r=>{finish=()=>{order.push(1);r()}}),()=>true);
 await Promise.resolve();await Promise.resolve();
 const b=dispatchChannelDelivery({op:"message_update",event_id:"b",channel_sequence:2,d:{channel_id:"serial",id:"message"}} as WSMessage,async()=>{order.push(2)},()=>true);
 finish();await Promise.all([a,b]);expect(order).toEqual([1,2]);
});
it("falls back to a snapshot and pages forward with the returned cursor",async()=>{
 const snapshot=vi.fn().mockResolvedValue(undefined),apply=vi.fn().mockResolvedValue(undefined);
 api.mockResolvedValueOnce({success:true,data:{events:[],cursor:10,has_more:false,reset:true}});
 await resyncChannelDelivery("server","replay",apply,snapshot,()=>true);expect(snapshot).toHaveBeenCalledOnce();
 api.mockResolvedValueOnce({success:true,data:{events:[],cursor:110,has_more:true,reset:false}}).mockResolvedValueOnce({success:true,data:{events:[],cursor:111,has_more:false,reset:false}});
 await resyncChannelDelivery("server","replay",apply,snapshot,()=>true);expect(api.mock.calls[1][0]).toContain("after_sequence=10");expect(api.mock.calls[2][0]).toContain("after_sequence=110");
});
