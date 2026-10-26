---
title: HiChat JS Solver
sdk: docker
app_port: 7860
---

# Private EJS compute service

This optional service executes the bundled EJS 0.8.0 computation with pinned
Deno 2.9.8. Oracle retains all YouTube networking, authentication, public-content
checks and media downloads. This service receives no YouTube cookies and has
no YouTube/network access from the Deno subprocess. It is not an HTTP proxy.

Build this directory as the Docker context. The Python standard library is the
only application dependency. Python and Deno images are pinned by digest.
The two vendored EJS files were extracted unchanged from the official pinned
yt-dlp 2026.10.21 zipimport binary; startup verifies their SHA-256 hashes in
`app.py`. Their original license notices are retained. Any yt-dlp/EJS/Deno
upgrade requires matching wrapper validation, new hashes and a protocol revision.

Set the private `HICHAT_JS_SOLVER_TOKEN` secret to a random token of at least
32 characters. Do not put it in the image, source, command arguments or logs.
No account cookies or HF API credentials belong in this service. Deployment
does not provision or upgrade paid hardware automatically.

`GET /health` is public and reports liveness and pinned versions. `POST /solve`
requires `Authorization: Bearer <token>`, `Content-Type: application/json`, and
`X-HiChat-JS-Protocol: ejs-0.8.0-deno-2.9.8-v1`. It accepts exactly
`type`, `player`, `requests`, and `output_preprocessed`. Type must be `player`;
each request has exactly `type` (`n` or `sig`) and `challenges` (strings).
The service forces `output_preprocessed=false`. It uses its own EJS scripts
and accepts no executable code envelope, runtime arguments or file paths.

Limits: 8 MiB body, 6 MiB player, 16 requests, 512 total challenges of at most
16 KiB each, 1 MiB stdout, one active request with no queue, five seconds to
read its body, and twenty seconds for computation. Duplicate/unknown fields,
non-finite numbers, malformed output and partial EJS failures are rejected.
Busy returns HTTP 429. Errors use only `{"error":"fixed_code"}`; stderr,
payloads, credentials and tracebacks are never returned or logged.

Deno receives a fresh private directory, a fixed environment containing
`DENO_V8_FLAGS=--max-old-space-size=512,--max-semi-space-size=4`, and the
standard bundled-EJS `run` flags with no network, file, environment,
subprocess or FFI permissions granted. No service secrets enter that
environment. Disconnect, timeout, stderr or excessive stdout kills the
process group and reaps it before the next request. Heap settings do not cap
total RSS; retain host/container memory limits and measure concurrent usage.

Run `python -m unittest discover -v` in this directory. Process-group and
real-Deno tests run on Linux; the real-Deno test requires `/usr/local/bin/deno`.
Tests use synthetic scripts/data and never contact YouTube. Passing these
tests is not deployed audio or LiveKit acceptance.
