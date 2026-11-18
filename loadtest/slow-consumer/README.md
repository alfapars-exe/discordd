# Non-reading local WebSocket probe

This helper obtains a real single-use WebSocket ticket and opens one connection
to a disposable loopback backend. After the upgrade it never reads messages.
It requests a 1,024-byte TCP receive buffer and sends an unsolicited protocol
pong plus an application heartbeat immediately and every 15 seconds. This keeps
the server's reader alive without consuming outgoing traffic. The requested
buffer size is not a measurement of the effective OS receive window.

Build from `server` with the repository's pinned Gorilla dependency:

```sh
go build -mod=readonly -o /owned/output/slow-consumer ../loadtest/slow-consumer/main.go
go test -mod=readonly -race ../loadtest/slow-consumer/main.go ../loadtest/slow-consumer/main_test.go -count=1 -timeout=30s
go vet -mod=readonly ../loadtest/slow-consumer/main.go ../loadtest/slow-consumer/main_test.go
```

The fixture must start the executable with a pipe for stdin, send one JSON object,
and close stdin. The object contains `base_url`, `access_token`, and
`hold_seconds` (1–900). Supply an ordinary fixture account's token through that
pipe; keep it out of command arguments, source files and published logs.
Only literal loopback IP addresses with an HTTP(S) root URL are accepted;
DNS names, credentials, query strings and fragments are rejected. Neither HTTP
redirects nor environment proxies are used. Input and ticket responses are bounded.

Stdout contains JSON `connected` and `finished` events. `connected` means HTTP
101, and does not prove admission to the application hub. `finished.reason` is
`write_failed`, `hold_completed`, or `cancelled`. Each event reports elapsed time,
completed keepalive pairs, the requested receive buffer size and
`post_upgrade_reader: false`. Setup/output errors use fixed codes on stderr and
exit nonzero; credentials, ticket URLs and HTTP response bodies are not printed.

The probe deliberately does not grade the server. A successful exit, a failed
write, or a local timeout alone cannot establish slow-consumer isolation. The
surrounding real PostgreSQL fixture must separately prove hub admission, removal
of the slow peer while healthy peers remain connected, complete healthy delivery
and persisted history, and cleanup. That natural TCP workload remains an open
acceptance gate; the helper's mocked ticket/real socket contracts do not close it.

The non-reading regression sends a unique server ping after observing both
keepalives. A forbidden reader would automatically echo that ping through Gorilla
and fail the test. A separate mutated copy of the executable was checked to fail
for exactly this reason; the repository implementation retains no reader.
