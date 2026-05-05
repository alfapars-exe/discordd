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
FROM node:22-alpine AS frontend
WORKDIR /app/client
COPY client/package.json client/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY client ./
RUN npm run build
# Output: /app/client/dist/

# ─── Stage 2: Go backend (embeds Stage 1 output) ───
# Debian/glibc base because go-libsql ships a prebuilt Rust C library that
# was linked against glibc (uses readdir64, fstat64, __res_init, mmap64,
# etc.). Those symbols don't exist on Alpine/musl, so the link step fails
# with "undefined reference to readdir64" if we stay on Alpine.
FROM golang:1.25-bookworm AS backend
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

# After source is present, `go mod tidy` can detect new imports (go-libsql)
# and add the missing go.sum entries before `go build` verifies them.
WORKDIR /app/server
RUN go mod tidy && \
    CGO_ENABLED=1 GOOS=linux GOARCH=amd64 \
    go build -trimpath -ldflags="-s -w" -o /out/hichat-server .

# ─── Stage 3: Runtime ───
# Stay on glibc (debian-slim) to match what go-libsql linked against. The
# image is ~30MB larger than alpine but the binary actually runs.
FROM debian:bookworm-slim
# yt-dlp + ffmpeg are runtime dependencies for the music bot service —
# yt-dlp resolves YouTube URLs into audio streams, ffmpeg encodes them as
# Ogg/Opus that LiveKit's Pion stack can publish. yt-dlp is pulled from
# the latest GitHub release at build time because Debian's apt-shipped
# package is months stale and YouTube tightens its protocol regularly.
RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates tzdata ffmpeg python3 curl && \
    curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
      -o /usr/local/bin/yt-dlp && \
    chmod +x /usr/local/bin/yt-dlp && \
    apt-get purge -y --auto-remove curl && \
    rm -rf /var/lib/apt/lists/*

# Sanity check — fail the image build immediately if yt-dlp / ffmpeg /
# python3 aren't actually executable. Prevents shipping a Space where the
# music bot silently fails at runtime due to a missing PATH entry.
RUN yt-dlp --version && ffmpeg -version | head -1 && python3 --version

WORKDIR /app
COPY --from=backend /out/hichat-server /app/hichat-server

# Run as root inside the container — the HF Storage Bucket mount at /data
# brings its own ownership (root-owned by default), so a non-root USER like
# `hichat` would get "permission denied" on mkdir /data/uploads. HF Spaces
# isolate the container itself, so root-in-container is the normal pattern.
# The Go binary will mkdir /data/uploads and /data/landing on first start.

# HF Space defaults to port 7860 (the value of $PORT inside the container).
ENV SERVER_HOST=0.0.0.0 \
    SERVER_PORT=7860 \
    UPLOAD_DIR=/data/uploads \
    DATABASE_PATH=/data/hichat.db

EXPOSE 7860
ENTRYPOINT ["/app/hichat-server"]
