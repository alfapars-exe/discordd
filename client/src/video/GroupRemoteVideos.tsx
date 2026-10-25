import{useTracks,type TrackReference}from "@livekit/components-react";
import{Track}from "livekit-client";
import AuthorizedVideoTrack from "./AuthorizedVideoTrack";
export default function GroupRemoteVideos(){const tracks=useTracks([{source:Track.Source.Camera,withPlaceholder:false},{source:Track.Source.ScreenShare,withPlaceholder:false}],{onlySubscribed:true});return <div className="group-remote-videos">{tracks.filter((track):track is TrackReference=>!track.participant.isLocal&&!!track.publication).map(track=><div key={track.publication.trackSid} style={{height:180,minWidth:240}}><AuthorizedVideoTrack trackRef={track}/></div>)}</div>}
