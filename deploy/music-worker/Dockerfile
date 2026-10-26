# Build from the repository root: docker build -f deploy/music-worker/Dockerfile .
# This image contains the outbound worker without the desktop/web application.
FROM golang:1.27.3-bookworm AS build
WORKDIR /src/server
COPY server/go.mod server/go.sum ./
RUN go mod download
COPY server ./
RUN CGO_ENABLED=1 go build -trimpath -ldflags="-s -w" -o /out/hichat-music-worker ./cmd/music-worker && \
    CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/hichat-js-exec ./cmd/hichat-js-exec

FROM denoland/deno:bin-2.9.8@sha256:b507583d3c68ba69f3ed2ce5969ae5b8b70f43421c781279c7aea06435263543 AS deno
FROM python:3.12-slim-bookworm@sha256:6a0e06f5ba0b373d051aabd3fffb9b873f27f9a2a3a14bcbe37dee6f0e3bbc70
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl ffmpeg && \
    curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/download/2026.10.21/yt-dlp -o /usr/local/bin/yt-dlp && \
    echo 'b7af77f686e95f7845ce8d09d21957718febb8b48b30555adb9dd2292ad7bf14  /usr/local/bin/yt-dlp' | sha256sum -c - && \
    chmod 0755 /usr/local/bin/yt-dlp && rm -rf /var/lib/apt/lists/*
COPY --from=deno /deno /usr/local/bin/deno
COPY --from=build /out/hichat-music-worker /usr/local/bin/hichat-music-worker
COPY --from=build /out/hichat-js-exec /usr/local/bin/hichat-js-exec
RUN yt-dlp --version && deno --version && hichat-js-exec --version && \
    ffmpeg -hide_banner -loglevel error -f lavfi -i anullsrc=r=48000:cl=stereo -t 0.1 -c:a libopus -f null -
USER 61150:61150
WORKDIR /tmp
CMD ["/usr/local/bin/hichat-music-worker"]
