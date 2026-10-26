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

Load the image on a host meeting the resource requirements below, validate `docker compose config --quiet`,
then run `docker compose up -d`. Set the matching app secret only after the
compatible app revision is deployed. On app restarts the worker reconnects;
disconnects cancel its active child processes. To roll back, unset the app
secret and stop only this compose project.

The worker allows one audio job and one metadata/search job at a time,
across all channels. A second simultaneous channel reports busy through the
existing rate-limit error. Pause backpressure must not block the separate
control or metadata connections. ffmpeg is still needed on the worker for
yt-dlp's section downloads when seeking; the main Opus encode remains in HF.

The worker explicitly selects Deno 2.9.8 for its bundled EJS scripts and sets
`DENO_V8_FLAGS=--max-old-space-size=512,--max-semi-space-size=4` in the child
environment. These are fixed application values; ambient runtime flags are not
forwarded. The same pinned Deno binary supports the app's local execution path
when the outbound worker is not configured.

Single-video metadata skips player JavaScript and permits missing media
formats because no audio is requested at that stage. The normal account,
provider clients and public-availability checks remain in use. Explicit
authentication, access or rate-limit denials still fail the job even if partial
metadata exists. Audio extraction still performs the full normal format and
JavaScript processing; a metadata result is not proof that the audio can play.

Extraction startup is serialized: metadata/search holds the extraction slot
until its subprocess exits, and audio holds it until the first media output.
Waiting counts against the existing request deadline, and cancellation releases
the slot. This avoids overlapping extraction startup; metadata can still
overlap an audio download after it starts streaming. First media output does
not prove that all solver memory has been released. Measure that overlap on
the target host before accepting concurrent use.

The worker has no published ports, runs as a dedicated non-root UID with a
read-only filesystem, and is capped at 1 GiB, two CPUs, 64 processes and a
32 MiB temporary filesystem. Swap is not added to the memory allowance. The
768 MiB reservation is a soft Docker limit,
not a `memory.high` throttle or a guarantee that memory remains available.
The Deno heap limit does not cap total RSS; Python, Go, native runtime memory
and temporary files also count against the container limit.

The existing 1 GB PostgreSQL host and its previous 320 MiB worker allowance do
not meet the validated requirements. Do not enable this profile on that host.
Provide at least 1 GiB available for the worker in addition to operating-system
and other-service headroom; a dedicated 2 GB host is a practical minimum.
Verify available memory, worker peak usage, and any co-located database and
backup services under concurrent audio/metadata load before enabling it.
This profile does not provision infrastructure. Do not allocate paid resources
automatically or alter the database/firewall as part of this deployment.

## Separate JavaScript computation

When the provider-connected host cannot afford the local Deno process, deploy
the pinned [compute service](solver/README.md) on a separate host. Oracle still
performs every ordinary YouTube request, account check and media download.
The compute service receives only the downloaded public player and bounded
challenge data. YouTube cookies never leave the provider-connected worker.

Build the smaller worker image from the repository root:

```sh
docker build -f deploy/music-worker/Dockerfile -t hichat-music-worker:REVIEWED_COMMIT .
```

Set `HICHAT_MUSIC_JS_ENDPOINT` to the solver's HTTPS origin and mount its separate
random application token as `secrets/js-solver.token`, mode 0600 owned by UID
61150. The solver uses that same value in `HICHAT_JS_SOLVER_TOKEN`. Neither an
HF API token nor the music transport token is used for computation. A protected
HF Space keeps source private while allowing requests authenticated by this
application token; private Spaces additionally require HF authentication.

```sh
docker compose -f compose.yaml -f compose.split.yaml config --quiet
docker compose -f compose.yaml -f compose.split.yaml up -d
```

The split override caps the provider worker at 320 MiB with no swap allowance
and one CPU. It never falls back to local Deno if the solver is unavailable.
The shim accepts only the exact pinned yt-dlp/EJS invocation and code envelope,
then passes typed JSON through a private per-job Unix socket. The parent retains
the solver token and binds request cancellation to the remote request. Runtime
or protocol upgrades require updating both sides together. A sleeping solver
must become ready before playback; liveness alone does not prove media access.

On 2026-10-26, the original public video produced 2,791,315 audio bytes through
this split path in 20.615 seconds, with first bytes at 19.706 seconds and a
172,347,392-byte Oracle peak. A ten-second sample decoded as non-silent Opus
(RMS -20.364 dB). This is provider-path evidence; channel playback, controls,
concurrent jobs and the available database headroom require their own checks.

## Acceptance

Unit and transport tests do not establish successful production playback.
Verify the original URL through the deployed worker with the dedicated account,
then check actual LiveKit join, first published samples, a listener receiving
non-silent decrypted music, pause/resume, seek and stop. Check that cancellation
reaps yt-dlp and its Deno/ffmpeg descendants and that reconnecting restores new
jobs. Observe only the music bot's track; do not record human voice channels.
Record precise source/runtime commits and resource readings. Do not call a
successful image build or `/api/ready` a music playback success.
