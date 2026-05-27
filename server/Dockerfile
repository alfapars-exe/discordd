# mqvi Go Backend — secondary Dockerfile, used by docker-compose.yml.
#
# NOTE: The PRIMARY production image is the repo-root /Dockerfile (HF Space
# build, multi-arch, CGO + libsql). This file is the lighter local-dev /
# self-host path: pure-Go SQLite only, no libsql, no music-bot deps.
#
# Why 1.25-bookworm not 1.25-alpine?
# go.mod requires `go 1.25.0`. Alpine's Go toolchain is fine, but matching
# the root Dockerfile (debian:bookworm-slim runtime + golang:1.25-bookworm
# builder) keeps the two images on the same glibc baseline so behaviour
# debugging in one transfers to the other.
#
# Why CGO_ENABLED=0 still works?
# The libsql import (database/database.go) has build constraints excluding
# all Go files when CGO is off. Go emits a "build constraints exclude all
# Go files" warning to stderr and silently continues — the second import
# (modernc.org/sqlite, pure-Go) supplies the driver, so DATABASE_PATH=...
# (local SQLite file) keeps working. Remote Turso/libSQL is unavailable
# from this image — operators using libsql:// URLs should run the root
# Dockerfile (CGO + libsql) instead.

# ─── Builder Stage ───
FROM golang:1.25-bookworm AS builder

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
