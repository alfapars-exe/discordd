# mqvi Go Backend — secondary Dockerfile, used by docker-compose.yml.
#
# NOTE: The PRIMARY production image is the repo-root /Dockerfile (HF Space
# build, multi-arch, CGO + libsql). This file is the lighter local-dev /
# self-host path: pure-Go SQLite only, no libsql. Music tools match the
# production image so enabling a voice channel works in both deployments.
#
# Why 1.26-bookworm not 1.26-alpine?
# go.mod requires `go 1.26`. Alpine's Go toolchain is fine, but matching
# the root Dockerfile (debian:bookworm-slim runtime + golang:1.26.5-bookworm
# builder) keeps the two images on the same glibc baseline so behaviour
# debugging in one transfers to the other.
#
# Why CGO_ENABLED=0 works?
# The libsql driver import lives in database/database_libsql.go behind
# `//go:build !windows && cgo`, so with CGO off it is excluded and the
# pure-Go modernc.org/sqlite driver supplies DATABASE_PATH=... Remote
# Turso/libSQL is unavailable from this image — operators using libsql://
# URLs should run the root Dockerfile (CGO + libsql) instead.
#
# That build tag used to be `!windows` only, and this comment used to claim
# Go merely warned and continued. It does not: the file was still compiled on
# Linux, go-libsql's own sources are all cgo-gated, and the build failed hard
# with "build constraints exclude all Go files in .../go-libsql". This image
# could not be built at all until that tag was corrected.

# ─── Builder Stage ───
FROM golang:1.27.2-bookworm AS builder

WORKDIR /build
COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o mqvi .

FROM denoland/deno:bin-2.9.8@sha256:b507583d3c68ba69f3ed2ce5969ae5b8b70f43421c781279c7aea06435263543 AS music-js

# ─── Runner Stage ───
FROM debian:bookworm-slim
COPY --from=music-js /deno /usr/local/bin/deno

ARG YT_DLP_VERSION=2026.10.21

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates tzdata curl ffmpeg python3; \
    BASE="https://github.com/yt-dlp/yt-dlp/releases/download/${YT_DLP_VERSION}"; \
    curl -fsSL "${BASE}/yt-dlp" -o /usr/local/bin/yt-dlp; \
    curl -fsSL "${BASE}/SHA2-256SUMS" -o /tmp/yt-dlp-sums; \
    EXPECTED=$(grep -E '  yt-dlp$' /tmp/yt-dlp-sums | awk '{print $1}'); \
    test -n "$EXPECTED"; \
    echo "${EXPECTED}  /usr/local/bin/yt-dlp" | sha256sum -c -; \
    chmod +x /usr/local/bin/yt-dlp; \
    rm /tmp/yt-dlp-sums; \
    rm -rf /var/lib/apt/lists/*

RUN yt-dlp --version && deno --version && ffmpeg -version | head -1
RUN ffmpeg -hide_banner -loglevel error -f lavfi -i anullsrc=r=48000:cl=stereo \
      -t 0.1 -c:a libopus -f ogg /tmp/hichat-music-smoke.ogg && \
    test -s /tmp/hichat-music-smoke.ogg && rm /tmp/hichat-music-smoke.ogg

WORKDIR /app

# Binary
COPY --from=builder /build/mqvi .

# Migrations
COPY --from=builder /build/database/migrations ./database/migrations

# Non-root user (uid 1000) — self-host path, no HF Space constraint here.
# /data must be writable by uid 1000; docker-compose `user:` override or
# host `chown -R 1000:1000 ./data` is required.
RUN useradd --create-home --uid 1000 --shell /sbin/nologin hichat && \
    mkdir -p /data/uploads && \
    chown -R hichat:hichat /data /app
USER hichat

EXPOSE 9090

# HEALTHCHECK — same shallow /api/health pattern as root Dockerfile.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS http://localhost:9090/api/health || exit 1

CMD ["./mqvi"]
