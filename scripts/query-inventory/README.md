# Repository query call inventory

From the repository root:

```powershell
go run ./scripts/query-inventory/main.go -root . > "$env:TEMP/hichat-query-inventory.json"
go test ./scripts/query-inventory/main.go ./scripts/query-inventory/main_test.go
```

This read-only AST inventory scans non-test Go files under `server/repository` and records method-name candidates for Exec, Query, QueryRow and Prepare, with and without Context. It records the correct query argument position and source location. Direct string literals include their SQL text. Same-file explicit string constants, parenthesized constants and constant concatenations are resolved using Go parser object bindings, including local shadowing. They are counted separately as constant_calls. Mutable variables, dynamic concatenations, imported/cross-file constants and implicit const declarations remain unresolved. Cyclic constant references fail closed.

The report is not execution tracing, verified database receiver typing, reachability, runtime query counting or semantic coverage. A method with a matching name on a different receiver is still a candidate. Build tags are not filtered: this is a source inventory across platform files. Dynamic SQL must be traced to its producer and actual database contract tests before being marked covered. The JSON contains source SQL; keep it with local verification evidence rather than treating it as production telemetry.

RF05 baseline on integration source e3b32199 plus this tool: 181 files, 957 candidate calls, 654 literal and 303 unresolved. Counts are revision-specific and do not close RF05. The remaining work is to map candidates to production query families, explicit dialect branches and positive/negative SQLite/PostgreSQL result fixtures.
