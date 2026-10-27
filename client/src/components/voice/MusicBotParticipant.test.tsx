import {act,fireEvent,render,screen,waitFor} from "@testing-library/react";
import {beforeEach,expect,it,vi} from "vitest";
const fixture=vi.hoisted(()=>({command:vi.fn(),valid:true}));
vi.mock("react-i18next",()=>({useTranslation:()=>({t:(key:string)=>key})}));
vi.mock("../../hooks/useMusicSlashCommand",()=>({useMusicSlashCommand:()=>fixture.command}));
vi.mock("../../api/musicProtocol",()=>({captureMusicScope:()=>({key:"scope",current:()=>fixture.valid})}));
vi.mock("../../stores/voiceStore",async()=>{
 const {create}=await import("zustand");
 return {useVoiceStore:create<import("../../stores/voiceStore").VoiceStore>((set)=>({musicBotStates:{},userVolumes:{},setUserVolume:(id:string,value:number)=>set(s=>({userVolumes:{...s.userVolumes,[id]:value}}))}) as import("../../stores/voiceStore").VoiceStore)};
});
import {useVoiceStore} from "../../stores/voiceStore";
import MusicBotParticipant from "./MusicBotParticipant";
import type {MusicBotChannelState} from "../../types/music";
const song=():MusicBotChannelState=>({server_id:"server",channel_id:"channel",session_id:"session",revision:1,is_active:true,is_paused:false,queue:[],elapsed_seconds:0,current_track:{video_id:"v",title:"song",duration_seconds:164,url:"https://youtube.com/watch?v=v",requested_by_user_id:"me",requested_by_name:"Me"}});
const open=()=>fireEvent.contextMenu(screen.getByRole("button",{name:"botControls"}),{clientX:40,clientY:50});
beforeEach(()=>{fixture.valid=true;fixture.command.mockReset().mockResolvedValue({handled:true,outcome:"success"});useVoiceStore.setState({musicBotStates:{channel:song()},userVolumes:{}});});
it.each([["pause","/pause"],["playNext","/skip"],["stop","/stop"]])("routes %s to the common channel command",async(label,cmd)=>{
 render(<MusicBotParticipant serverId="server" channelId="channel"/>);open();fireEvent.click(screen.getByRole("menuitem",{name:label}));await waitFor(()=>expect(fixture.command).toHaveBeenCalledWith(cmd));
});
it("resumes the common paused player",async()=>{
 useVoiceStore.setState({musicBotStates:{channel:{...song(),is_paused:true}}});render(<MusicBotParticipant serverId="server" channelId="channel"/>);open();fireEvent.click(screen.getByRole("menuitem",{name:"resume"}));await waitFor(()=>expect(fixture.command).toHaveBeenCalledWith("/resume"));
});
it("plays a URL through the same scoped slash command",async()=>{
 render(<MusicBotParticipant serverId="server" channelId="channel"/>);open();fireEvent.click(screen.getByRole("menuitem",{name:"playSong"}));fireEvent.change(screen.getByLabelText("songQuery"),{target:{value:"https://youtube.com/watch?v=0KbRhUtFwkc"}});fireEvent.click(screen.getByRole("button",{name:"playSong"}));await waitFor(()=>expect(fixture.command).toHaveBeenCalledWith("/play https://youtube.com/watch?v=0KbRhUtFwkc"));
});
it("changes only the explicitly personal bot volume",()=>{
 render(<MusicBotParticipant serverId="server" channelId="channel"/>);open();fireEvent.click(screen.getByRole("menuitem",{name:"personalVolume (100%)"}));fireEvent.click(screen.getByRole("menuitem",{name:"50%"}));expect(useVoiceStore.getState().userVolumes["__music_bot__:channel"]).toBe(50);expect(fixture.command).not.toHaveBeenCalled();
});
it("rejects an old menu action after ownership changes",()=>{
 render(<MusicBotParticipant serverId="server" channelId="channel"/>);open();fixture.valid=false;fireEvent.click(screen.getByRole("menuitem",{name:"stop"}));expect(fixture.command).not.toHaveBeenCalled();
});
it("hides a menu when the bot session is replaced",()=>{
 render(<MusicBotParticipant serverId="server" channelId="channel"/>);open();act(()=>useVoiceStore.setState({musicBotStates:{channel:{...song(),session_id:"new"}}}));expect(screen.queryByRole("menu")).not.toBeInTheDocument();expect(fixture.command).not.toHaveBeenCalled();
});
