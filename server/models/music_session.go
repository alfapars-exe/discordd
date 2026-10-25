package models

// MusicSession is the durable, deliberately-paused form of a channel queue.
// Queue includes the interrupted current track at index zero so a restart
// never loses it; restoring requires an explicit user action.
type MusicSession struct {
	SessionID  string
	ChannelID  string
	ServerID   string
	Queue      []MusicTrack
	RepeatMode string
	Revision   uint64
}
