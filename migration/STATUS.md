# Migration status — 2026-11-01

This is the current inventory. Older dated verification sections describe earlier
proofs. The Rust/Flutter client is **not a complete replacement product**.
Windows/web implementation and physical-device acceptance are tracked separately.

## Locally implemented and exercised

- Go login/MFA, cookie refresh, logout and account-generation fences.
- Source IndexedDB retirement, target-bound capsule, authenticated roster checks,
  DPAPI/file ownership on Windows and encrypted IndexedDB/Web Lock ownership.
- Independent fresh devices persist keys before registration and reuse their
  protected identity after restart. Sending rechecks the registered device.
- Flutter text-DM list/history/composer connects the Go API to Rust X3DH, Double
  Ratchet, peer/sibling fanout, durable pending requests and source-bound caches.
  State commits before outbound bytes; repeated preparation reuses ciphertext.
- Real legacy TypeScript Signal/IndexedDB/cache/exporter code exchanged messages
  with Rust. Both Windows and web targets then took over the retired source's
  live identity, opened old DM history and continued two-way DH-ratcheted messaging.
  The web target retained history after reload and cleared visible chat on logout.
- A supporting Go server stores text-DM request IDs/hashes in the message/unread/
  notification transaction. Uncertain sends can explicitly resume with identical
  saved bytes, including after restart. A dedicated endpoint refuses downgrade to
  a non-idempotent server. Legacy uncertain sends remain history-reconciliation-only.
- History uses server append order and a fetched cursor; an own-message echo
  cannot skip incoming rows. Message text has explicit accessibility semantics;
  widget tests cover 320/390 px with keyboard insets.
- The earlier encrypted LiveKit, direct microphone/camera, Windows 0x0 capture
  repair, opt-in loopback audio and external-window HUD proofs remain available.

## Remaining software work

| ID | Work still required |
|---|---|
| W1 | Complete automatic retry/ack scheduling and transactional DM WebSocket outbox. Current text retries are explicitly resumed; multipart delivery is not covered. Legacy uncertain sends cannot safely auto-resend. Simultaneous session re-establishment needs explicit confirmation; live imported sessions never silently rewind. |
| W2 | Channel/group orchestration: sender-key distribution, membership/epoch changes, receive/fanout and imported pending-group delivery. Pure crypto kernels are not the complete dispatcher. |
| W3 | Attachments, secure file opening/upload/download recovery, uncached historical ciphertext, editing/deletion/reactions/search and complete unread/read flows. |
| W4 | Existing design/feature and Turkish/English parity, server/channel/group/friend/settings UI, full keyboard/IME/screen-reader acceptance and session restoration across application starts. |
| W5 | P2P screen/source renegotiation and TURN/NAT, seamless SFU rekey/reconnect, original DSP/noise parity, global PTT and complete platform integration. |
| W6 | Flutter installers with original identity/data continuity and real automatic upgrades; production web hosting with COOP/COEP/WASM MIME. Portable preview is separate from stable Go/Electron 2.11.125. |
| W7 | Rust API/WebSocket server, workers/bots and database adapters preserving all contracts, migrations and job ownership. Go is still authoritative; there is no Rust production cutover or traffic split. |
| W8 | Linux/macOS/native Android/iOS product builds, signing and platform implementations. Portable Rust-core CI is not complete Flutter platform acceptance. |

Physical cameras/microphones/output devices, games/HUD/PTT, system-audio exclusion
and feedback, long calls, network/device/permission changes, sleep/wake, real
Android Chrome/iOS Safari and two physical clients remain open. Other browser
engines, abrupt process/power failure at every boundary, performance comparisons
and signed upgrades also remain open. See DEVICE_ACCEPTANCE.md.

## Reproduction

Use a disposable Go API on loopback 19090 with certificate-authenticated PostgreSQL
18 and `proof-server.mjs` on 18080. Never substitute production credentials/URLs.
`scripts/start-e2e-postgres.sh` documents the TLS fixture.

`prepare-chat-qa.mjs` creates fresh friends and an encrypted DM. Run
`integration_test/chat_test.dart` on Windows with `HICHAT_CHAT_QA_FILE` pointing at
the generated ignored `.local/chat-qa.json`.

`build-legacy-chat.mjs` bundles the actual legacy code behind the fixed loopback
`/__qa/legacy-chat.html` fixture. `--interop` prepares another pair for
`chat_handoff_test.dart`; the test writes `interop-intent.json`, receives the legacy
message, replies, waits for source export, imports, verifies history and exchanges
new messages. Drive the reference harness using ego-browser; no key/capsule/token
belongs in a published receipt.

`--web-handoff` prepares a web target and `web_chat_peer_test.dart` verifies its
Windows peer. Use the handoff/message tabs in ego-browser and record source
retirement, two-way messages, reload and logout separately. Keep the browser
visible for UI input; automation timeouts do not count as protocol success.
