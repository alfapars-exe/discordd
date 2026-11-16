# Local PostgreSQL fan-out and slow-consumer profile

`run-local-fanout.ps1` packages the previously recorded 620-second Windows
profile as a repository command. It requires Windows, Docker Desktop in Linux
container mode, Git, tar, Node, Go and k6. It does not require an existing account,
database or deployment endpoint. PostgreSQL 18.6 is pinned by image digest and
uses freshly generated certificates with `verify-full` and client certificates.

From the repository root, run:

```powershell
./loadtest/run-local-fanout.ps1 -ArtifactRoot G:/owned-profile-artifacts -K6Binary C:/tools/k6.exe -GoBinary 'C:/Program Files/Go/bin/go.exe'
```

Choose an artifact volume with at least 4 GiB free; the Windows system volume
must also have at least 1 GiB free before starting. During the workload the
corresponding floors remain 1 GiB and 512 MiB. The Go build cache and temporary
compiler files use the artifact volume. An ordinary Windows Go backend runs
outside Docker; the disposable PostgreSQL instance uses Docker's normal storage.
This is not an in-memory database or a race-instrumented performance baseline.

The launcher archives the selected repository's committed `HEAD`, including the
profile tools. Commit the tooling before running it. Uncommitted source changes
are excluded; the checkout is never reset, switched or cleaned. `-SourceRoot`
can name another checkout containing the committed tools. Inputs are hashed
before the run and checked again during cleanup; changes reject the profile.

The fixed workload creates a private guild and channel, twenty healthy ordinary
users, one non-reading ordinary user and a separate profiling administrator.
All memberships and socket tickets use the real API. Twenty k6 sockets each
send 290 messages and remain open for 620 seconds. The extra Go peer requests
a small TCP receive buffer and sends keepalives without reading server output.
Admission, a 21→20 pump transition while healthy peers remain, the slow helper's
exit and all healthy socket completions are required. All 5,800 sends, 116,000
unique healthy deliveries, twenty receiver digests and sender ACK IDs must
reconcile with paginated persisted history. Six recovery samples must show
zero read/write pumps. The requested receive buffer is not the actual OS window.

The uniquely named `local-fanout-*` artifact directory retains source hashes,
backend/k6 logs, history pages, samples and `capacity-report.json`. `resultStatus`
must be `completed`, `failurePhases` empty, `databaseDropped` and `sourceStable`
true, and `launcher-cleanup.json` must have no failures. Cleanup joins every
registered child even when another child fails. The launcher verifies the
container's unique label and full ID before removing it, removes its image by
the captured image ID, and removes only explicit credential files within its
own directory. Build caches, binaries and nonprivate evidence remain available.

The private fixture config and database descriptor contain disposable credentials
while the run is active. Do not publish the artifact directory wholesale. Public
evidence should select the report, samples, history and sanitized diagnostics;
neither credentials nor private keys belong in a PR. Docker build context is
restricted to its Dockerfile, certificate generator and access configuration.

New launcher runs use evidence version 2 in both the owner marker and report.
After history/recovery verification, the workload awaits one bounded telemetry
read before cleanup begins. The query has a ten-second process timeout and
128 KiB output limit; it selects numeric runtime/pool/HTTP fields and three
numeric diagnostics only. Ten to twenty ordered minute buckets are required.
Application logs, route text and unknown future columns are excluded.
Read or validation failure rejects the profile and records a timestamped stage
plus safe child exit/system codes while still running cleanup. This does not
identify the cause of an older external observer's unrecorded failure.
Persisted buckets do not force-flush the final partial minute or establish a
capacity, latency or pool-wait budget.

The offline auditor supports legacy version-1 captures without upgrading their
measurement claims. Version 2 requires completed telemetry and its recorded
completion before cleanup; missing data or mismatched marker versions fail.

After the launcher has finished, independently check persisted messages,
receiver digests, ACK IDs, source hashes and recorded resource/cleanup evidence:

```sh
python loadtest/audit_local_profile.py /path/to/local-fanout-artifact-directory
```

The standard-library auditor writes `independent-audit.json` with a PASS or FAIL
verdict; a failed rerun replaces an older PASS and exits nonzero. Always check the
command's exit code, including when the report itself could not be written.
Keep the generated `local-fanout-<32 hex digits>` directory name when moving or
sharing evidence. Its owner marker must match; unrelated CLI paths are refused
without writing a verdict. Every input/output path must remain inside that
fixture after filesystem resolution.
It requires the fixed 58-page history and twenty complete receiver receipts;
summary counters cannot replace missing pages. It preserves PostgreSQL's source
sequence order, including valid timestamp inversions. Acceptance checks remain
enabled under `python -O`. This is an offline evidence audit: observing that host
processes, containers and images are absent remains a separate check.

The normal Node contract command also covers ownership, TLS weakening, foreign
targets, changed source inputs, filesystem links, child-start failure and joined
cleanup:

```sh
node --experimental-vm-modules --test loadtest/*.test.mjs
python -m unittest discover -s loadtest -p 'test_*.py'
```

Those contracts do not execute the full workload. A profile demonstrates bounded
correctness and observed resources on the recorded machine and source revision.
It does not establish a production SLA, capacity, variance, churn, long-soak,
physical media, or whether queue overflow versus the write deadline removed the
slow peer. The separate runtime telemetry observer used in historical evidence
is not silently replaced by these contracts or the offline audit.


For a numeric pool summary of a completed version-2 report, use the pure
`summarizePoolTelemetry(report.runtimeTelemetry.rows)` export from
`loadtest/pool-summary.mjs`. It sums the recorded diagnostic deltas rather than
subtracting or summing cumulative counters. The result exposes missing minutes,
counter decreases and configured max-open changes (zero means unlimited).
`meanRecordedWaitMs` divides recorded wait duration by recorded wait count;
it is null when no waits are recorded. Server duration deltas are truncated to
milliseconds. Sampled peaks are not continuous peaks. This summary establishes
neither query/request latency percentiles nor a capacity or pool budget.


Repository profile latency distribution (from `server`, either configured test backend):

```powershell
$env:HICHAT_PROFILE_LATENCY = '1'
go test ./repository -run '^(TestProfileLatencyNearestRanks|TestProfileProjectionSQLQueryCount)$' -bench '^BenchmarkGroupPublicProfilePopulation$' -benchtime=30x -count=9 -v
```

Each repetition records thirty complete repository-operation durations, then
reports nearest-rank p50/p95 and the unsorted raw nanosecond samples. Calibration
runs must be excluded from analysis. Sampling includes clock and assertion
costs; it changes the timing instrumentation relative to the earlier mean-only
benchmark. Use fixed iterations up to10000 when sampling is enabled; larger
counts fail before allocating samples. Zero-duration observations on tiny/empty
operations reflect clock resolution, not zero cost. These are sequential
repository percentiles, not HTTP latency or concurrent pool budgets. Unset
`HICHAT_PROFILE_LATENCY` to run without per-operation sampling.
