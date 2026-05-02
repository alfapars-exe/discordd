# Tayfa — Hugging Face Space (Docker SDK) single-container build
# ----------------------------------------------------------------
# Stage 1: build the React frontend with Vite into client/dist/
# Stage 2: copy that dist into server/static/dist/ so go:embed picks it up,
#          then build a static Go binary (CGO disabled, so only pure-Go drivers
#          like modernc.org/sqlite and libsql-client-go work — that's the design).
# Stage 3: Alpine runtime with just the binary + ca-certificates.

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

# Module cache layer — only re-downloads when go.mod/go.sum change.
COPY server/go.mod server/go.sum ./server/
WORKDIR /app/server
# go mod tidy reconciles go.sum with go.mod (needed because we added libsql-client-go).
RUN go mod tidy && go mod download

# Source code
WORKDIR /app
COPY server ./server
# Frontend bundle goes where //go:embed all:dist expects it.
COPY --from=frontend /app/client/dist ./server/static/dist

WORKDIR /app/server
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
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
