# HiChat self-host backend. Requires PostgreSQL 18 with verified mutual TLS.
# SQLite is retained only for offline imports; libSQL is removed.
FROM golang:1.27.3-bookworm AS builder

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
