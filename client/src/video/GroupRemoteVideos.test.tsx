import{render,screen}from "@testing-library/react";
import{expect,it,vi}from "vitest";
const h=vi.hoisted(()=>({tracks:[]as unknown[],request:vi.fn()}));
vi.mock("@livekit/components-react",()=>({useTracks:(...args:unknown[])=>{h.request(...args);return h.tracks}}));
vi.mock("./AuthorizedVideoTrack",()=>({default:({trackRef}:{trackRef:{publication:{trackSid:string}}})=><div data-testid={trackRef.publication.trackSid}/>}));
import GroupRemoteVideos from "./GroupRemoteVideos";
it("renders actual subscribed incoming camera/screen tiles only, never own capture or placeholders",()=>{h.tracks=[{participant:{isLocal:false},publication:{trackSid:"remote-camera"}},{participant:{isLocal:false},publication:{trackSid:"remote-screen"}},{participant:{isLocal:true},publication:{trackSid:"own-camera"}},{participant:{isLocal:false}}];render(<GroupRemoteVideos/>);expect(screen.getByTestId("remote-camera")).toBeTruthy();expect(screen.getByTestId("remote-screen")).toBeTruthy();expect(screen.queryByTestId("own-camera")).toBeNull();expect(h.request).toHaveBeenCalledWith(expect.anything(),{onlySubscribed:true})});
