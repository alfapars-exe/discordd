package models

import "time"

// MusicBotUserID is the literal users.id row created by migration 060.
// LiveKit identity for a bot instance is `MusicBotUserID + ":" + channelID`
// so the same base user can have one participant per voice channel.
const MusicBotUserID = "__music_bot__"

// MusicTrack — a single song in the queue or currently playing.
//
// All fields except URL come from yt-dlp metadata extraction (single
// `--print '%(...)j'` JSON pass). URL is the original user-supplied
// YouTube link; the bot re-extracts the audio stream URL at play time
// because YouTube's CDN signed URLs expire after a few hours.
type MusicTrack struct {
	VideoID           string `json:"video_id"`           // YouTube ID, used for thumbnail too
	Title             string `json:"title"`
	Artist            string `json:"artist,omitempty"`   // yt-dlp 'uploader' or 'channel'
	Thumbnail         string `json:"thumbnail,omitempty"`
	DurationSeconds   int    `json:"duration_seconds"`
	URL               string `json:"url"`                // original input
	RequestedByUserID string `json:"requested_by_user_id"`
	RequestedByName   string `json:"requested_by_name"`  // display name for UI; saves a join
}

// MusicBotChannelState — the snapshot a frontend needs to render the
// MusicBotPanel for a single voice channel. Broadcast over WebSocket
// (`music_bot_state` opcode) any time the queue, current track, or
// pause flag changes; also returned from the GET /music/state endpoint
// for initial load and reconnect.
type MusicBotChannelState struct {
	ChannelID    string       `json:"channel_id"`
	ServerID     string       `json:"server_id"`
	IsActive     bool         `json:"is_active"`               // true while bot is in the room
	CurrentTrack *MusicTrack  `json:"current_track,omitempty"` // nil when paused-from-start or queue is exhausted
	Queue        []MusicTrack `json:"queue"`                   // FIFO; index 0 plays after current finishes
	IsPaused     bool         `json:"is_paused"`
	StartedAt    *time.Time   `json:"started_at,omitempty"`    // CurrentTrack play start; client computes elapsed
}

// MusicBotErrorPayload — the `music_bot_error` WebSocket event's data. Sent
// once per failed track (Fatal=false, Failures = consecutive failures so far)
// and once more with Fatal=true right before the bot gives up and leaves.
//
// Reason is a fixed code (forbidden, bot_check, unavailable, age_restricted,
// geo_blocked, rate_limited, network, stalled, tool_missing, unknown), never
// error text: the raw error and the yt-dlp/ffmpeg stderr stay in the server
// log. This struct deliberately has no free-text error field, so none can be
// added to the payload by accident.
type MusicBotErrorPayload struct {
	ChannelID  string `json:"channel_id"`
	ServerID   string `json:"server_id"`
	TrackTitle string `json:"track_title"`
	Reason     string `json:"reason"`
	Failures   int    `json:"failures"`
	Fatal      bool   `json:"fatal"`
}
