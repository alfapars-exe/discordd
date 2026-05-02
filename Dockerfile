# Tayfa — Hugging Face Space (Docker SDK) single-container build
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
FROM golang:1.25-alpine AS backend
WORKDIR /app

# go-libsql is a CGO native binding — it links against a prebuilt libsql C
# library shipped with the module. We need a C toolchain (gcc + musl-dev,
# pulled in by build-base) at compile time. The runtime image is the same
# Alpine/musl base so the binary's musl link target matches.
RUN apk add --no-cache build-base

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
    go build -trimpath -ldflags="-s -w" -o /out/tayfa-server .

# ─── Stage 3: Runtime ───
FROM alpine:3.20
RUN apk add --no-cache ca-certificates tzdata && \
    addgroup -S tayfa && adduser -S -G tayfa tayfa

WORKDIR /app
COPY --from=backend /out/tayfa-server /app/tayfa-server

# /data is the HF Space Storage Bucket mount point. The bucket is created with
# read/write access so the app can persist uploads here. ChownRecursive on a
# bucket-mounted dir would be wasteful, so we just ensure the subdir exists.
RUN mkdir -p /data/uploads /data/landing && \
    chown -R tayfa:tayfa /data

USER tayfa

# HF Space defaults to port 7860 (the value of $PORT inside the container).
ENV SERVER_HOST=0.0.0.0 \
    SERVER_PORT=7860 \
    UPLOAD_DIR=/data/uploads \
    DATABASE_PATH=/data/tayfa.db

EXPOSE 7860
ENTRYPOINT ["/app/tayfa-server"]
