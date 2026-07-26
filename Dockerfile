# HiChat! — Hugging Face Space (Docker SDK) single-container build
# ----------------------------------------------------------------
# Stage 1: build the React frontend with Vite into client/dist/
# Stage 2: copy that dist into server/static/dist/ so go:embed picks it up,
#          then build the Go binary. CGO is enabled so we can use the
#          tursodatabase/go-libsql native driver, which is the only one that
#          handles the current Turso wire protocol correctly. The pure-Go
#          modernc.org/sqlite driver is still used for the local SQLite path.
# Stage 3: Alpine runtime with the binary + ca-certificates.

# ─── Stage 1: React (Vite) ───
FROM node:26-alpine AS frontend
WORKDIR /app/client
COPY client/package.json client/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY client ./
# Root package.json carries the canonical app version. vite.config.ts reads
# it via `readFileSync(resolve(__dirname, "../package.json"))` and inlines
# the version into the bundle as __APP_VERSION__ so client logs can be
# filtered by release. Without this copy the read throws ENOENT mid-build
# and the whole Space goes red. (vite.config.ts also falls back gracefully
# to "0.0.0" if this file is somehow missing — defense in depth.)
COPY package.json /app/package.json
# DSN-gated Sentry (see client/src/monitoring/sentry.ts): unset by default,
# so a build without --build-arg VITE_SENTRY_DSN=... stays Sentry-free.
ARG VITE_SENTRY_DSN
ENV VITE_SENTRY_DSN=${VITE_SENTRY_DSN}
RUN npm run build
# Output: /app/client/dist/

# ─── Stage 2: Go backend (embeds Stage 1 output) ───
# Debian/glibc base because go-libsql ships a prebuilt Rust C library that
# was linked against glibc (uses readdir64, fstat64, __res_init, mmap64,
# etc.). Those symbols don't exist on Alpine/musl, so the link step fails
# with "undefined reference to readdir64" if we stay on Alpine.
# server/go.mod declares `go 1.26` (dependabot 0067570); pinning the exact
# builder tag keeps the build hermetic instead of relying on GOTOOLCHAIN=auto
# to fetch a newer toolchain over the network mid-build. 1.26.5 also still
# satisfies the >=1.25.12 stdlib fixes CI's govulncheck cares about:
# GO-2026-5856 (crypto/tls), GO-2026-5037 (crypto/x509), GO-2026-5039
# (net/textproto) — matches the go-version pin in server-ci.yml.
FROM golang:1.26.5-bookworm AS backend
WORKDIR /app

# Module cache layer: download what's already in go.sum. We don't run
# `go mod tidy` here because tidy needs the *.go source files to resolve
# imports.
COPY server/go.mod server/go.sum ./server/
WORKDIR /app/server
RUN go mod download

# Source code
WORKDIR /app
COPY server ./server
# Frontend bundle goes where //go:embed all:dist expects it.
COPY --from=frontend /app/client/dist ./server/static/dist

# Build pins to whatever the checked-in go.mod / go.sum already resolve
# to. We deliberately do NOT run `go mod tidy` inside the build — tidy
# can mutate go.sum by re-resolving indirect dependency versions, which
# makes byte-identical commits produce different images depending on
# when they were built. CI (.github/workflows/server-ci.yml) runs a
# tidy diff check on every PR, so the lockfile is kept honest there.
#
# CGO_ENABLED=1 is required because tursodatabase/go-libsql is a
# CGO-only Rust wrapper. GOARCH is left empty so buildx picks it up
# from the --platform flag (linux/amd64, linux/arm64).
WORKDIR /app/server
RUN CGO_ENABLED=1 GOOS=linux \
    go build -trimpath -ldflags="-s -w" -o /out/hichat-server .

# ─── Stage 3: Runtime ───
# Stay on glibc (debian-slim) to match what go-libsql linked against. The
# image is ~30MB larger than alpine but the binary actually runs.
FROM debian:bookworm-slim

# yt-dlp pinned + checksum-verified. The previous "latest" fetch was
# both a supply-chain risk (any compromise of the yt-dlp release artifact
# would land in our image on the next rebuild) and a reproducibility
# bug (identical commits produced different images as yt-dlp shipped
# new releases). Override at build time with --build-arg YT_DLP_VERSION=...
# to take a newer version; the official SHA2-256SUMS file from the same
# release is fetched and verified, so the build fails loudly on any
# tampering instead of silently shipping an unknown binary.
ARG YT_DLP_VERSION=2024.11.04

# ffmpeg + tzdata + ca-certificates from apt are still pulled "latest
# in distro" — Debian's bookworm-slim apt snapshot is reproducible
# within the lifetime of the base image tag, which is good enough for
# our threat model. The base image tag itself (debian:bookworm-slim) is
# the supply-chain boundary; operators wanting full reproducibility
# should pin to a digest (debian:bookworm-slim@sha256:...).
RUN set -eux; \
    apt-get update; \
    # sqlite3 CLI is consumed by the backup service for `VACUUM INTO`
    # (the snapshot must be a single, page-aligned file independent of
    # any WAL sidecar). python3-pip is needed to install the hf CLI.
    apt-get install -y --no-install-recommends \
      ca-certificates tzdata ffmpeg python3 python3-pip sqlite3 \
      curl wget \
      bash procps \
      git git-lfs; \
    # hf CLI for backup snapshots to the configured HF Storage Bucket.
    # `--break-system-packages` is required on Debian Bookworm (PEP 668);
    # the image is dedicated to this app so the venv ceremony would add
    # disk for no isolation gain. hf_transfer is a Rust-based parallel
    # uploader that the backup service auto-enables via env var.
    pip3 install --no-cache-dir --break-system-packages 'huggingface_hub[hf_transfer]>=0.20'; \
    BASE="https://github.com/yt-dlp/yt-dlp/releases/download/${YT_DLP_VERSION}"; \
    curl -fsSL "${BASE}/yt-dlp" -o /usr/local/bin/yt-dlp; \
    curl -fsSL "${BASE}/SHA2-256SUMS" -o /tmp/yt-dlp-sums; \
    EXPECTED=$(grep -E '  yt-dlp$' /tmp/yt-dlp-sums | awk '{print $1}'); \
    if [ -z "$EXPECTED" ]; then echo "yt-dlp checksum not found in SHA2-256SUMS"; exit 1; fi; \
    echo "${EXPECTED}  /usr/local/bin/yt-dlp" | sha256sum -c -; \
    chmod +x /usr/local/bin/yt-dlp; \
    rm /tmp/yt-dlp-sums; \
    rm -rf /var/lib/apt/lists/*
# NOTE: curl was previously purged here to shrink the image, but that
# silently broke the HEALTHCHECK below (which calls curl) and blocked HF
# Spaces Dev Mode's VS Code server from starting. curl now stays.

# Sanity check — fail the image build immediately if any required CLI
# isn't actually executable. Prevents shipping a Space where the music
# bot silently fails at runtime due to a missing PATH entry, or where
# the backup service can't find `hf` / `sqlite3` and silently no-ops.
RUN yt-dlp --version && ffmpeg -version | head -1 && python3 --version && \
    sqlite3 --version && hf --version

WORKDIR /app
COPY --from=backend /out/hichat-server /app/hichat-server

# HF Spaces Dev Mode requires /app to be owned by uid 1000 so the SSH
# session (which logs in as that uid) can edit files there. The container's
# main process (the Go binary) still runs as root for HF /data mount compat
# — only the directory ownership changes.
RUN chown -R 1000:1000 /app

# Default runtime is still root because the HF Spaces deployment mounts
# /data with root-owned ownership and a non-root USER would fail mkdir
# /data/uploads at first start. HF isolates the container itself, so
# root-in-container is the documented pattern there.
#
# Self-hosters should run with `--user 1000:1000` and pre-chown the
# /data volume on the host (or use a docker-compose `user:` override);
# a follow-up Dockerfile.selfhost variant will codify that.
# The Go binary will mkdir /data/uploads and /data/landing on first start.

# HF Space defaults to port 7860 (the value of $PORT inside the container).
ENV SERVER_HOST=0.0.0.0 \
    SERVER_PORT=7860 \
    UPLOAD_DIR=/data/uploads \
    DATABASE_PATH=/data/hichat.db

EXPOSE 7860

# HEALTHCHECK — deliberately targets /api/health, the LIVENESS endpoint, which
# always answers 200 while the HTTP layer is up. Dependency health is reported
# in that response BODY ("status": "ok" | "degraded", plus a "checks" object
# refreshed every 30s by the background readiness checker), and /api/ready is
# the strict readiness probe that answers 503.
#
# This split is intentional: Docker restarts the container when this check
# fails, and a restart cannot heal a remote-Turso outage — gating it on deep
# readiness would only produce restart flapping during a transient blip. Deep
# status belongs to monitors (which read the body or poll /api/ready), not to
# the restart gate.
# Tunables:
#   --interval=30s : how often the check fires
#   --timeout=5s   : per-check timeout (curl exits non-zero on timeout)
#   --start-period=60s : cold-start grace window. Boot-time HF Bucket restore
#                        plus DB migrations regularly exceed the old 20s on a
#                        cold Space start, which restarted a healthy boot.
#   --retries=3    : N consecutive failures = container "unhealthy"
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD curl -fsS http://localhost:${SERVER_PORT}/api/health || exit 1

# --- Self-host hardening (commented out for HF Space compatibility) ---
# Uncomment for self-hosted deployments. HF Spaces requires root because
# the platform mounts /data as root-owned at first start.
#
# RUN useradd --create-home --uid 1000 --shell /sbin/nologin hichat && \
#     mkdir -p /data/uploads /data/landing && \
#     chown -R hichat:hichat /data /app
# USER hichat
# -------------------------------------------------------------------

# CMD (not ENTRYPOINT) — HF Spaces Dev Mode requires CMD so its daemon
# can start the app as a sub-process and restart it via the Refresh
# button without killing the container. For production (Dev Mode off)
# CMD behaves identically to ENTRYPOINT here since the binary takes no
# extra argv.
CMD ["/app/hichat-server"]
