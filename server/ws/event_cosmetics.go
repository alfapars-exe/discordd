package ws

// OpUserCosmeticsUpdate tells clients that a user's equipped cosmetics
// changed. Payload is models.CosmeticsUpdateEvent. One event per affected
// context, coalesced per request: BroadcastToServer(S) carries the user's
// slots resolved for S (plain: true and empty slots when the user looks
// plain there); BroadcastToUser(self) with server_id null carries the
// global slots. Deliberately NOT in BotReadableOps.
const OpUserCosmeticsUpdate = "user_cosmetics_update"
