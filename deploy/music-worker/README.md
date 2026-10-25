# Outbound music worker

The optional worker runs yt-dlp on a host that can reach YouTube. It opens
authenticated WSS connections to the existing app over HTTPS/443; no inbound
worker port or firewall change is needed. HF retains its ffmpeg Opus encoder,
LiveKit publisher, channel permissions and queue. The same application image
contains both executables and the pinned yt-dlp/Deno/ffmpeg dependencies.

This is an opt-in deployment. With `HICHAT_MUSIC_WORKER_TOKEN` unset, local
execution is unchanged. A configured but disconnected worker fails music
requests promptly; it does not make the rest of HiChat unready.

## Credentials

Use a dedicated YouTube account and a manually exported Netscape cookie file.
Never commit, upload to chat, or log cookies. Follow the official yt-dlp cookie
export guidance: https://github.com/yt-dlp/yt-dlp/wiki/Extractors#exporting-youtube-cookies

Generate a random token of at least 32 bytes. Store it as the app's
`HICHAT_MUSIC_WORKER_TOKEN` secret and as `secrets/worker.token` beside this
compose file. Store the account cookies as `secrets/youtube.cookies.txt`.
On Linux, both files must be mode 0600 and owned by UID/GID 61150; their parent
directory should be root-owned mode 0700. Docker mounts only these two files,
read-only, into the dedicated worker. Per-job cookie copies live in private
temporary directories and are deleted when the subprocess exits.

Account-only/private/member-only videos are rejected. Authentication is for
normal access to public videos, not to expose the account's private content.
Provider authentication/availability errors remain failures. Expired cookies
must be replaced by the account owner; do not automate login or challenge bypass.

## Deployment and resource limits

Keep this service separate from `deploy/infra` and its PostgreSQL configuration.
Build the application Dockerfile from the reviewed source. Set these two
non-secret variables in a private deployment `.env` file:

```dotenv
HICHAT_MUSIC_WORKER_IMAGE=hichat-music-worker:REVIEWED_COMMIT
HICHAT_MUSIC_WORKER_ENDPOINT=https://YOUR-APP-HOST
```

Load the image on the existing host, validate `docker compose config --quiet`,
then run `docker compose up -d`. Set the matching app secret only after the
compatible app revision is deployed. On app restarts the worker reconnects;
disconnects cancel its active child processes. To roll back, unset the app
secret and stop only this compose project.

The small host allows one audio job and one metadata/search job at a time,
across all channels. A second simultaneous channel reports busy through the
existing rate-limit error. Pause backpressure must not block the separate
control or metadata connections. ffmpeg is still needed on the worker for
yt-dlp's section downloads when seeking; the main Opus encode remains in HF.

The worker has no published ports, runs as a dedicated non-root UID with a
read-only filesystem, and is capped at 320 MiB, half a CPU, 64 processes and a
32 MiB temporary filesystem. The 224 MiB reservation is a soft Docker limit,
not a guarantee that memory remains available. Verify host available memory,
worker peak usage, PostgreSQL health and backup operation under concurrent
audio/metadata load before enabling it. Do not allocate new paid infrastructure
or alter the database/firewall as part of this deployment.

## Acceptance

Unit and transport tests do not establish successful production playback.
Verify the original URL through the deployed worker with the dedicated account,
then check actual LiveKit join, first published samples, a listener receiving
non-silent decrypted music, pause/resume, seek and stop. Check that cancellation
reaps yt-dlp and its Deno/ffmpeg descendants and that reconnecting restores new
jobs. Observe only the music bot's track; do not record human voice channels.
Record precise source/runtime commits and resource readings. Do not call a
successful image build or `/api/ready` a music playback success.
