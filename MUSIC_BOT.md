# HiChat music bot

The bot resolves public YouTube video/playlist URLs, joins the selected voice
channel through LiveKit, and publishes an Opus audio track. Everyone in the
room hears the same queue. Playback state is in memory and is cleared on a
backend restart. This is not a browser-side YouTube embed.

## Runtime requirements

Both the repository-root production Dockerfile and `server/Dockerfile`
(Docker Compose/self-hosting) include:

- FFmpeg with the `libopus` encoder and Python 3 from Debian Bookworm.
- The official `yt-dlp` zipimport executable, pinned to `2026.10.21` and
  verified against the release's SHA-256 manifest.
- Deno `2.9.8`, copied from its official binary image pinned to the multiarch
  manifest digest. The image supports Linux amd64 and arm64.

YouTube challenge solving requires a supported JavaScript runtime. The
official yt-dlp executable already bundles matching EJS solver scripts;
Deno is enabled automatically. See the upstream
[EJS setup guide](https://github.com/yt-dlp/yt-dlp/wiki/EJS) and
[pinned yt-dlp release](https://github.com/yt-dlp/yt-dlp/releases/tag/2026.10.21).
The application disables remote component downloads, third-party plugins, and
user/system yt-dlp configuration. Do not depend on `yt-dlp.conf` for runtime
options. No browser cookies or logged-in YouTube account are required or read.

Native development servers need `yt-dlp`, `deno`, and `ffmpeg` on their process
PATH before starting the Go backend. Installing these only on the frontend
machine does not provide them to the server. Restart the backend after
installing tools because executable resolution is cached.

Basic checks inside the **backend** environment:

```sh
yt-dlp --version
deno --version
ffmpeg -version
ffmpeg -hide_banner -encoders
```

Confirm `libopus` appears in the encoder list. The Docker build checks tool
execution and performs a short offline Opus encode, but a successful image
build alone does not verify YouTube access or LiveKit connectivity.
Rebuild the backend image after dependency changes;
restarting an old image does not install the new tools.

## Operation and limits

Join a voice channel, then type `/play <public YouTube URL>` in a channel's
message composer. For example:

```text
/play https://www.youtube.com/watch?v=YE7VzlLtp-4
```

Recognized music commands control the voice channel you are currently joined
to, even when you browse a different text channel or server; they are not
posted as chat messages. A rejected command stays in the composer for
correction. After a request timeout, check the queue before retrying: the
server may already have accepted the track.

| Command | Action |
| --- | --- |
| `/play <URL>` | Start the bot if needed and append a video or playlist to its FIFO queue. |
| `/pause` | Pause the shared audio and elapsed clock. |
| `/resume` | Continue the paused track. |
| `/skip` | End the current track and advance to the next queued track. |
| `/stop` | Disconnect the bot and clear the entire queue. |

The music panel also provides pause/resume, skip and stop buttons. It shows
buffering/playing/paused state, title, artist, elapsed time and a preview of
the next three queued tracks (plus the remaining count). State is refreshed
after reconnect and on focus. Playback commands require the channel's Speak
permission; Stop requires Manage Channels because it affects every listener.

The API supports enqueue, skip, pause, resume, stop and state retrieval under
`/api/servers/{serverId}/channels/{channelId}/music/`.

- Use a video URL (`watch`, `youtu.be`, `shorts`, `embed`, `live`) or a YouTube
  playlist URL. Other providers, free-text searches, private videos and
  account-restricted media are not supported.
- Queue entries are reconstructed as canonical, individual `watch?v=...`
  URLs. Playback never replays an entire playlist for each entry or retains
  an expiring CDN URL from metadata.
- A video link containing `list=...` or `start_radio=1` plays only that
  video. Use an explicit `/playlist?list=...` URL to add a whole playlist.
- Extraction requests at most 201 entries and keeps at most 4 MiB of output.
  A channel queue holds at most 200 waiting tracks; responses list only the
  accepted tracks. Up to four metadata extractions run concurrently.
- Extraction has a 30-second timeout. A stalled audio pipeline is cancelled
  after 45 seconds without progress. Three consecutive track failures stop
  the bot. An idle bot leaves after five minutes.
- Pause/resume gates audio samples on both Windows and Linux; it does not
  depend on Unix process signals. The elapsed counter reflects emitted audio,
  excluding extraction/buffering and paused time.
- LiveKit credentials, server/channel access and voice permissions must be
  configured. A successful metadata lookup is not proof that listeners have
  received audio.

## Failure diagnosis

Read the user-visible reason and the backend's `service.musicbot` log. Client
responses use fixed reason codes, not subprocess stderr or credentials.

| Symptom | Check |
| --- | --- |
| Tool unavailable | Check tools on the backend PATH and rebuild/restart. |
| YouTube unavailable | Check the public video in a browser; removed/private videos cannot play. |
| Bot check, forbidden, rate limited, region/age restricted | YouTube can reject the hosting IP or media independently of application health. Use another public video or wait; do not disable URL guards or add account cookies as a workaround. |
| Metadata succeeds, no audio | Inspect FFmpeg errors, LiveKit connection/publication, listener audio/autoplay permissions and local volume. |
| Playback stalled | Check backend outbound networking and CPU capacity; the watchdog cleans up the stuck pipeline. |

The URL host/path allowlist, public-IP DNS check, fixed argv and
`--use-extractors Youtube.*` are deliberate controls. Keep them in both
metadata extraction and playback when updating the tooling.

## Verification

Run backend music regression tests from the repository root (no YouTube
credentials required). External smoke tests skip unless explicitly enabled:

```sh
cd server
go test ./services ./handlers -run 'Music|Ytdlp|ExtractTracks|PlayTrack|PlayLoop|StallWatchdog|Enqueue|FlatPlaylist|ParseMusicMetadata' -count=1
```

### Offline FFmpeg smoke

With `ffmpeg` on the test process's PATH, run from `server/`:

```sh
MUSIC_FFMPEG_SMOKE=1 go test ./services -run '^TestMusicFFmpegSmoke$' -count=1 -v
```

PowerShell equivalent:

```powershell
$env:MUSIC_FFMPEG_SMOKE = '1'
go test ./services -run '^TestMusicFFmpegSmoke$' -count=1 -v
Remove-Item Env:MUSIC_FFMPEG_SMOKE
```

`music_bot_clock_test.go` generates a short WAV tone, runs the production
FFmpeg arguments, and validates the resulting Opus packets. It needs neither
YouTube nor LiveKit and does not verify network delivery.

### YouTube → LiveKit smoke

Use a disposable **loopback-only** LiveKit development instance, never a
production server. The test starts no services, creates a uniquely named
room, and uses only LiveKit's development credentials (`devkey` / `secret`).
Have `yt-dlp`, `deno` and `ffmpeg` on PATH. The public video must be one you
are permitted to play; substitute its single-video URL below if necessary.

Start the development LiveKit instance in a separate terminal (the local
Windows validation used LiveKit `v1.13.10`):

```sh
livekit-server --dev --bind 127.0.0.1 --node-ip 127.0.0.1 --port 17880 --rtc.tcp_port 17881 --udp-port 17882
```

Keep it running, then execute the test from `server/` in another terminal:

```sh
MUSIC_YOUTUBE_SMOKE_URL='https://www.youtube.com/watch?v=YE7VzlLtp-4' \
MUSIC_LIVEKIT_SMOKE_URL='ws://127.0.0.1:17880' \
go test ./services -run '^TestMusicYouTubeLiveKitSmoke$' -count=1 -v -timeout 2m
```

PowerShell equivalent:

```powershell
$env:MUSIC_YOUTUBE_SMOKE_URL = 'https://www.youtube.com/watch?v=YE7VzlLtp-4'
$env:MUSIC_LIVEKIT_SMOKE_URL = 'ws://127.0.0.1:17880'
go test ./services -run '^TestMusicYouTubeLiveKitSmoke$' -count=1 -v -timeout 2m
Remove-Item Env:MUSIC_YOUTUBE_SMOKE_URL, Env:MUSIC_LIVEKIT_SMOKE_URL
```

`music_bot_live_integration_test.go` runs real extraction and encoding, joins
an independent LiveKit listener, captures received RTP, decodes it with
FFmpeg, and checks for non-silent audio. It also checks pause/resume, queueing
a second track, skip and stop. Only `127.0.0.1`, `localhost` and `::1` are
accepted as LiveKit hosts. Stop the disposable development server when done.

### Observed validation and release boundary

During local Windows validation on 2026-10-22, both the real FFmpeg smoke and
the public YouTube → FFmpeg → loopback LiveKit → independent listener test
passed, including decoding non-silent received audio and exercising
pause/resume, queue, skip and stop. This establishes that tested local path;
packet counts and run times are not availability or performance guarantees.

The updated Docker images have **not been built/verified** in this session
because the Docker daemon was unavailable. Nothing was deployed to production.
YouTube may still reject a deployment's hosting IP or restricted media even
when the same public video works locally.

Before releasing, build both relevant images and test a public video and
playlist from the deployed backend with two real app clients. Verify audible
output, controls, empty-channel cleanup, reconnect state and error handling.
The loopback service test does not cover browser audio permissions, production
networking or every UI interaction.
