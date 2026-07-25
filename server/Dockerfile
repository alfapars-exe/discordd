# mqvi Go Backend — secondary Dockerfile, used by docker-compose.yml.
#
# NOTE: The PRIMARY production image is the repo-root /Dockerfile (HF Space
# build, multi-arch, CGO + libsql). This file is the lighter local-dev /
# self-host path: pure-Go SQLite only, no libsql, no music-bot deps.
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
FROM golang:1.26.5-bookworm AS builder

WORKDIR /build
COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o mqvi .

# ─── Runner Stage ───
FROM debian:bookworm-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates tzdata curl && \
    rm -rf /var/lib/apt/lists/*

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
