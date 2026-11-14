# Frozen integrated baseline: 8ec41413

Source: `8ec41413f7ac03f72a53a1c11010df76283d1cf2`. This is the frozen baseline, not the current candidate. Local server and acceptance captures record clean worktrees and stable before/after source identities. Windows local runtime: Go1.27.4, CGO0 (no race), Node26.13.1/npm11.20.0. Linux CI runtime: Go1.26.11, Node22.23.4/npm10.9.9. Do not compare timings across these profiles as a performance regression.

| Profile / command | Exit / outcome | Duration and kind | Counts / artifact |
| --- | --- | --- | --- |
| Windows server: `go test -json ./... -count=1 -p=2 -timeout=15m` | 0 | 207.528s command wall | 4324 pass / 84 skip including subtests; `refactor-integration-8ec-server-baseline-2026-11-14.json` |
| Windows welcome-bot: `go test -json ./... -count=1 -p=2 -timeout=60s` | 0 | 10.358s command wall | 20 pass / 0 skip; `refactor-integration-8ec-bot-baseline-2026-11-14.json` |
| Local client TypeScript / ESLint / production build | all 0 | Total local command wall not captured | 0 lint errors / 2 warnings; `refactor-integration-8ec-preflight-2026-11-14.json` |
| Local Vitest coverage | 0 | 106.344s test-result span, NOT full command wall | 476 files; 4824 pass / 1 pending; lines67.53%, branches64.04%, statements66.59%, functions61.01%; same preflight receipt |
| Linux CI client lint / Vitest / build | success | 33s / 221s / 23s CI step walls | Run43557593050, job132333839946; do not mix subsequent Node audio/CSP tests into Vitest totals |
| Linux CI Electron: `npm run electron:test` | success | 5s CI step wall; 1.715s TAP duration | 400 pass / 0 skip. Separate 14 load-profile and 40 quality-runner tests are not Electron suite counts. Job132333839900 |
| Linux production Chromium / WebKit / delivered mail | success | 173s / 45s / 23s CI step walls | 14 / 1 / 2 passed respectively, including profile setup. No crypto-recovery browser test existed at this baseline. Job132333839916 |
| Acceptance checker: `node scripts/check-implementation-coverage.mjs --json` | 0: structure valid | 0.204s wall | 261 behaviors: 2 accepted, 11 excluded, 248 pending; `refactor-rf02-8ec-acceptance-evidence-2026-11-14.json` |
| Same checker plus `--strict` | 1: acceptance incomplete | 0.234s wall | Expected rejection of 248 pending behaviors. This is not a passing product gate. |

CI terminal evidence: `refactor-integration-8ec-terminal-2026-11-14.json`, 36/36 successful checks, Server CI43557593050. Selected authoritative job-log summaries: `refactor-rf02-8ec-ci-summaries-2026-11-14.json`. Native PostgreSQL and mTLS profiles have separate receipts; general Windows skips do not prove those contracts.

Historical failure must remain separate: the task ledger records 423 client files, 4106 passing / 8 failing tests before the UserBar fixture correction and 9 targeted passes afterward. Its primary raw result was not located in this audit; treat those historical counts as ledger evidence, not independently reverified measurements. Current inspection found no diff between da506e3b and 8ec for the two corrected UserBar tests and no changed assertion/test/skip declarations in the da506e3b patch. The correction supplied useTracks and authorized group/remote-participant fixture metadata; it was not reapplied.

Original preflight archive paths were relocated intact to `G:/hichat-verification-overflow-20261114/preflight-8ec-source.zip` and `preflight-8ec-expanded-source` when C storage ran low. Raw local report paths inside older receipts remain historical; committed summaries and immutable CI are distinct evidence. Missing local wall durations and historical raw failure evidence are explicit limitations. This table does not close RF02 or any other card by itself, and does not accept the 248 pending product behaviors.
