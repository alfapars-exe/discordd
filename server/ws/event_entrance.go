package ws

// OpEntranceSoundPlay tells the participants of a voice channel (the joiner
// included) to play the joiner's entrance sound. Payload is
// models.EntranceSoundPlayEvent, sent with BroadcastToUsers only — never
// server-wide. Server-authoritative: there is no client "play" request.
// Deliberately NOT in BotReadableOps.
const OpEntranceSoundPlay = "entrance_sound_play"
