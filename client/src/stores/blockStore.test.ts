import {beforeEach,expect,it,vi} from "vitest";
vi.mock("../api/block",()=>({listBlocked:vi.fn(),blockUser:vi.fn(),unblockUser:vi.fn()}));
import * as api from "../api/block";
import {useBlockStore} from "./blockStore";
import {useAuthStore} from "./authStore";
import {clearTokens} from "../api/client";
beforeEach(()=>{vi.clearAllMocks();useAuthStore.setState({user:{id:"alice"} as never});useBlockStore.setState({blockedUserIds:[],isLoading:false});});
it("does not duplicate an own block when the WebSocket event arrives before HTTP success",async()=>{
  vi.mocked(api.blockUser).mockImplementationOnce(async()=>{
    useBlockStore.getState().handleUserBlock({user_id:"alice",blocked_user_id:"bob"});
    return {success:true};
  });
  expect(await useBlockStore.getState().blockUser("bob")).toBe(true);
  expect(useBlockStore.getState().blockedUserIds).toEqual(["bob"]);
});
it("keeps our block when the other party blocks or unblocks us",()=>{
  useBlockStore.setState({blockedUserIds:["bob"]});
  useBlockStore.getState().handleUserBlock({user_id:"bob",blocked_user_id:"alice"});
  useBlockStore.getState().handleUserUnblock({user_id:"bob",unblocked_user_id:"alice"});
  expect(useBlockStore.getState().blockedUserIds).toEqual(["bob"]);
  useBlockStore.getState().handleUserUnblock({user_id:"alice",unblocked_user_id:"bob"});
  expect(useBlockStore.getState().blockedUserIds).toEqual([]);
});
it("ignores a block response after switching accounts",async()=>{
  let finish!:(value:{success:boolean})=>void;
  vi.mocked(api.blockUser).mockReturnValueOnce(new Promise(resolve=>{finish=resolve;}));
  const pending=useBlockStore.getState().blockUser("bob");
  useAuthStore.setState({user:{id:"new-owner"} as never});
  finish({success:true});
  expect(await pending).toBe(false);expect(useBlockStore.getState().blockedUserIds).toEqual([]);
});
it("ignores old-session unblock success even after the same account signs in again",async()=>{
  let finish!:(value:{success:boolean})=>void;
  vi.mocked(api.unblockUser).mockReturnValueOnce(new Promise(resolve=>{finish=resolve;}));
  useBlockStore.setState({blockedUserIds:["bob"]});
  const pending=useBlockStore.getState().unblockUser("bob");
  clearTokens();useAuthStore.setState({user:{id:"alice"} as never});
  finish({success:true});
  expect(await pending).toBe(false);expect(useBlockStore.getState().blockedUserIds).toEqual([]);
  expect(useBlockStore.getState().snapshotReady).toBe(false);
});
it("does not overwrite a newer WebSocket block with an old list response",async()=>{
  let finish!:(value:{success:boolean;data:[]})=>void;
  vi.mocked(api.listBlocked).mockReturnValueOnce(new Promise(resolve=>{finish=resolve;}));
  const pending=useBlockStore.getState().fetchBlocked();
  useBlockStore.getState().handleUserBlock({user_id:"alice",blocked_user_id:"bob"});
  finish({success:true,data:[]});await pending;
  expect(useBlockStore.getState().blockedUserIds).toEqual(["bob"]);expect(useBlockStore.getState().isLoading).toBe(false);
});
it("serializes opposite actions for one target in invocation order",async()=>{
  let finish!:(value:{success:boolean})=>void;
  vi.mocked(api.blockUser).mockReturnValueOnce(new Promise(resolve=>{finish=resolve;}));
  vi.mocked(api.unblockUser).mockResolvedValueOnce({success:true});
  const first=useBlockStore.getState().blockUser("bob"),second=useBlockStore.getState().unblockUser("bob");
  expect(api.unblockUser).not.toHaveBeenCalled();
  finish({success:true});expect(await first).toBe(true);expect(await second).toBe(true);
  expect(api.unblockUser).toHaveBeenCalledOnce();expect(useBlockStore.getState().blockedUserIds).toEqual([]);
});
it("cancels queued mutations when the session changes",async()=>{
  let finish!:(value:{success:boolean})=>void;
  vi.mocked(api.blockUser).mockReturnValueOnce(new Promise(resolve=>{finish=resolve;}));
  const first=useBlockStore.getState().blockUser("bob"),second=useBlockStore.getState().unblockUser("bob");
  clearTokens();finish({success:true});
  expect(await first).toBe(false);expect(await second).toBe(false);expect(api.unblockUser).not.toHaveBeenCalled();
});
it("releases a failed queue and allows the next request",async()=>{
  vi.mocked(api.blockUser).mockRejectedValueOnce(new Error("offline"));
  expect(await useBlockStore.getState().blockUser("bob")).toBe(false);
  vi.mocked(api.blockUser).mockResolvedValueOnce({success:true});
  expect(await useBlockStore.getState().blockUser("bob")).toBe(true);
  expect(useBlockStore.getState().blockedUserIds).toEqual(["bob"]);
});

it("authorizes sensitive projections only after a successful current-session block list",async()=>{
  vi.mocked(api.listBlocked).mockResolvedValueOnce({success:true,data:[]});
  await useBlockStore.getState().fetchBlocked();
  expect(useBlockStore.getState().snapshotReady).toBe(true);
  expect(useBlockStore.getState().ownerId).toBe("alice");
  vi.mocked(api.listBlocked).mockResolvedValueOnce({success:false});
  await useBlockStore.getState().fetchBlocked();
  expect(useBlockStore.getState().snapshotReady).toBe(false);
});

it("clears block provenance synchronously when the account changes",async()=>{
  vi.mocked(api.listBlocked).mockResolvedValueOnce({success:true,data:[]});
  await useBlockStore.getState().fetchBlocked();
  useAuthStore.setState({user:{id:"other"} as never});
  expect(useBlockStore.getState().snapshotReady).toBe(false);
  expect(useBlockStore.getState().ownerId).toBe("other");
});
