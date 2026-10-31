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

- History recovery stays read-only. The separate device-handoff path now retires
  the source and persists protected state/peer preparation; see HANDOFF.md for
  storage evidence and remaining chat/network/attachment acceptance.
- Full P2P/media/HUD parity and acceptance, original noise-engine parity,
  global PTT, system-audio exclusion acceptance and gapless rekey remain open.
- No latency/quality/memory improvement or all-platform feature parity is claimed.
- Chromium user-agent emulation is not Android hardware or iOS Safari evidence.
- Production credentials, release signing, hosted CI and auto-update acceptance
  have not been exercised. The Go production runtime remains authoritative.

## 2026-10-31 incremental status

| Item | Local implementation/evidence | Outstanding acceptance |
|---|---|---|
| Active device/ratchet handoff | source v2 retirement, target-bound capsule, pending-group rewrap, Windows DPAPI/file lock and web encrypted IDB/Web Lock; restart/idempotent peer preparation tested | complete chat dispatch/receive/fanout, abrupt crash points and physical multi-device migration; see HANDOFF.md |
| P2P | Flutter microphone/camera call adapter; two Chromium peers exchange decoded video and nonzero synthetic-tone audio through direct DTLS-SRTP | exact legacy-client interop, screen-source renegotiation, NAT/TURN, physical capture/long calls/network changes |
| Windows HUD | Rust external-window HUD; hidden Win32 runtime validates creation/styles/background hiding | visible real game, DPI/multiple monitors, fullscreen/anti-cheat, global PTT |
| Windows audio | opt-in SDK WASAPI path; owned synthetic application tone arrives in encrypted browser receiver; stop unpublishes audio | full-system own-process exclusion/feedback, device changes, actual game/output devices and sustained capture |
| Web/mobile browser | existing login/history remains the priority; system audio uses explicit browser permission/chooser | actual Android Chrome and Safari/WebKit permission/background/device behavior |

Native Android/iOS/macOS/Linux device acceptance remains separate. No row above
counts an emulated browser, hidden HWND or synthetic tone as physical acceptance.


The previous 0x0 native-window capture failure is repaired by the pinned SDK
capture-options/start-result patch. The strict native/browser fixture now asserts
decoded video and positive synthetic audio in both directions. Physical camera,
screen picker, sustained capture and real games remain unaccepted. Latest receipt:
evidence/device-handoff-capture.json; windows-media.json is historical.
