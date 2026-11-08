# Windows startup

The main window opens before release checking. Updates still download in the background and use the existing restart banner, tray action and install-on-quit behavior.

Session restoration refreshes the HttpOnly cookie before requesting the current user, avoiding a predictable initial 401. React shares an in-flight initialization and ignores a restore superseded by login/logout. Route imports and translation loading overlap session validation.

The versioned localStorage snapshot is scoped to the backend origin and one last authenticated account. It contains display name, user ID, server IDs/names and channel IDs/names/types only. It is bounded to 128 Ki characters, 100 servers and 300 channels per server, and expires after seven days. Logout or explicit credential rejection removes it; account changes replace it. Unavailable/full/malformed storage never blocks startup. The preview has no links, buttons or message content. It does not authenticate, initialize encryption, reconnect voice or restore permissions. Only the matching server list is hydrated after current-user validation; channel data and rights are fetched again.

Existing sessions already persist through HttpOnly refresh cookies. Electron's existing remembered-password feature uses OS safeStorage; this change does not add plaintext credential storage or trust an old login flag.

## Reproduce

Build baseline and candidate with production frontend assets, compile Electron and package each with electron-builder --win --dir. Install e2e dependencies first. With no concurrent builds/tests, run:

```powershell
$env:STARTUP_BENCH_DIR = "$env:TEMP/hichat-startup-comparison"
node scripts/measure-windows-startup.cjs before C:/path/to/baseline/HiChat.exe 5
node scripts/measure-windows-startup.cjs after C:/path/to/candidate/HiChat.exe 5
```

This uses separate profiles, synthetic users and a controlled 250 ms API response/WS-ready delay. It does not use the installed user's profile. Native window visibility is timed from process launch. Renderer timings start at a separate controlled reload after fixture installation; do not add the columns or present them as production network timings. Round 0 has an empty profile; rounds 1-4 have warm metadata. The updater feed is real. Small-sample nearest-rank p95 equals the maximum. No OS/disk cache flush is performed.

Evidence: implementation/verification/startup-cache-windows-2026-11-08.json. Warm renderer UI median 1379 to 887.5 ms; fresh channel 1510 to 926 ms; preview 44.55 ms. Native window visibility median 609 to 585.5 ms changed little. Real production session latency and physical cold boot remain separate acceptance measurements.
