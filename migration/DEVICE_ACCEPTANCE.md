# Device acceptance ledger

Priority: Windows, desktop web and mobile-browser login. Native mobile/Linux/macOS
acceptance is tracked separately; lack of hardware/signing is never counted as pass.

| Target | Local evidence | Still required |
|---|---|---|
| Windows x64 | Go login, Rust recovery-history reader, encrypted SFU join/logout; synthetic Chrome camera + synthetic tab video decoded | physical microphone/camera, device removal, long calls, native screen picker/audio exclusion, installer upgrade |
| Desktop Chromium | real local login/history/logout and encrypted synthetic publishing | Firefox, Edge, physical media and long/reconnect/permission-revocation sessions |
| Android UA in Chromium, 390 px | login/history/logout with touch/mobile layout | real Android Chrome with HTTPS, keyboard/autofill, network changes/background/permission lifecycle |
| iPhone UA in Chromium, 320 px | login/history/logout with touch/mobile layout | real iOS Safari/WebKit, keyboard/autofill, storage policies, tab suspension and media |
| Linux | source scaffold/core CI definition only | native build, X11/Wayland portal capture and device tests |
| macOS | source scaffold only | macOS builder, signing/notarization, permissions and device tests |
| Android native | permission declarations/scaffold only | SDK/NDK, signed build, foreground service and capture lifecycle |
| iOS native | usage descriptions/background-audio declarations/scaffold only | macOS/Xcode, provisioning, ReplayKit extension, audio-session and device tests |

## Additional product gates

- History reader is deliberately read-only. Active device identity/ratchet handoff,
  pending-send transfer, encrypted attachment opening and future E2EE sends are not
  implemented by displaying the backup's cached messages.
- P2P signaling/calling, original noise-engine parity, global PTT/game overlay,
  process-exclusive native system-audio capture and gapless rekey remain open.
- No latency/quality/memory improvement or all-platform feature parity is claimed.
- Chromium user-agent emulation is not Android hardware or iOS Safari evidence.
- Production credentials, release signing, hosted CI and auto-update acceptance
  have not been exercised. The Go production runtime remains authoritative.
