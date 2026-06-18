# welcome-bot

A first-party **welcome bot** for Hichat, written as a standalone Go program. It
is the DX proof for the bot platform: it lives *outside* the server module and
talks to a running Hichat server purely over the public gateway (WebSocket) and
REST API — the same surfaces any third-party bot would use.

## What it does

1. Dials the read-only bot gateway: `GET /api/bot/gateway`, authenticated with
   the bot's `hb_…` token in the `Authorization: Bearer …` header.
2. Reads gateway events. On `member_join`, it parses the joining member and
   posts a welcome message into a configured channel.
3. Logs every welcome it posts plus the HTTP status code.

## How it maps to the platform

- **Receives** the `member_join` op from the gateway. That op is on the bot
  gateway's read-only allow-list (`ws.BotReadableOps`), so the bot sees member
  joins but not the sensitive event families (voice, DM, E2EE, presence, etc.).
- **Acts** through the REST message-create endpoint with its bot token — the
  *same* endpoint and `content` body field a human client uses. The bot token
  flows through the normal HTTP auth middleware; there is no bot-only write path.

## Environment variables

| Var               | Example                  | Meaning                                              |
| ----------------- | ------------------------ | ---------------------------------------------------- |
| `HICHAT_BASE`     | `http://localhost:8080`  | Base URL of the running server (no trailing slash).  |
| `BOT_TOKEN`       | `hb_xxxxxxxx…`           | The bot's bearer token (shown once at creation).     |
| `WELCOME_CHANNEL` | `9f3c…` (channel id)     | Channel the welcome is posted into.                  |
| `WELCOME_SERVER`  | `5a1b…` (server id)      | Server the channel lives in — the message-create route is server-scoped, so this is required. |

The `WELCOME_SERVER` var exists because Hichat's message-create route is
**server-scoped**: `POST /api/servers/{serverId}/channels/{channelId}/messages`.
The bot also uses it to ignore `member_join` events from any *other* server it
might belong to.

## Manual end-to-end acceptance procedure

1. **Start the server locally** (e.g. `http://localhost:8080`).
2. **Create the bot** as a normal (human) account:

   ```
   POST /api/bots
   { "username": "welcomebot", "display_name": "Welcome" }
   ```

   Capture the returned `token` — it is shown **once**. Set it as `BOT_TOKEN`.
3. **Add the bot to a test server** and make sure its role can post in the
   channel you'll use as `WELCOME_CHANNEL`. Record that channel id and the
   server id (`WELCOME_SERVER`).
4. **Run the bot** with the env vars set:

   ```sh
   HICHAT_BASE=http://localhost:8080 \
   BOT_TOKEN=hb_… \
   WELCOME_CHANNEL=<channel-id> \
   WELCOME_SERVER=<server-id> \
   go run .
   ```

   It logs `welcome-bot connected …` once the gateway handshake succeeds.
5. **From a second account, join the server** (via invite).
6. **Expected:** within ~1s the bot posts `Aramiza hos geldin, @<name>!` to
   `WELCOME_CHANNEL`, and its log shows `welcome posted to channel … (status 201)`.

## Build

This is a separate Go module. Build it on its own:

```sh
go mod tidy
go build ./...
```

It pins the same `github.com/gorilla/websocket` version the server uses, so the
module cache is shared.
