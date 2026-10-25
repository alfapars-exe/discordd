# HiChat infrastructure rollout

## Current state (2026-10-25, production PostgreSQL active)

The HF production application now uses Oracle PostgreSQL 18. The final
post-pause snapshot passed all 97 table content/count checks and FK/sequence
validation, and its schema was atomically promoted to `public`.
`HICHAT_MAINTENANCE=0`; the live readiness endpoint returns HTTP 200.

- Frankfurt A1 creation returned insufficient capacity in all three availability domains.
- The approved fallback `hichat-infra` uses an Always Free E2.1.Micro with a 50 GB boot disk. The existing LiveKit Micro is unchanged. Combined boot allocation was verified as 97 GB; recheck the account before any further allocation.
- PostgreSQL 18.6 runs in Docker on the new Micro. The pinned image and memory limits are in `compose.yaml`. Data is on `/srv/hichat/postgres`.
- PostgreSQL listens on TCP 8080. TLS 1.3, SCRAM and a CA-signed client certificate matching the application role are all mandatory. The `hichat-postgres` NSG is attached only to `hichat-infra`; the temporary shared-subnet 8080 rule was removed. Management panels remain closed.
- A real SQL connection from the HF Space passed with verified TLS and its client certificate. A connection without a client certificate was rejected.
- Hourly encrypted dumps are uploaded to the private `infinayazilim/hichat-db-backups` bucket. The production archive `20261025T013846Z.dump.age` was delivered and downloaded for byte verification. It was then decrypted/restored into an isolated database; all 97 production table counts and PostgreSQL row-content SHA-256 aggregates matched the sealed pre-backup baseline. The isolated database and temporary recovery identity were removed. The current daily copy was refreshed from this production archive and remotely verified as well.
- Prometheus, Grafana and Uptime Kuma are deferred under the Micro fallback.
- The exact tested backend is pinned from HF revision `7dd5dc948acef85c7523cb7f7ba215707523a4ce`; a pre-DB maintenance gate was added. Existing production frontend sources were retained. HF production revision is `77c59c3796de5c83da7b7091746157874b511199`.
- Registration/login, server creation, messaging, pg_trgm search, concurrent preference updates, MFA setup/enforcement/recovery and session revocation passed against real Oracle PostgreSQL from the HF runtime.
- The complete rehearsal compared normalized row hashes and counts across 97 tables and passed deferred FK/sequence checks. Timestamp values are normalized to PostgreSQL microsecond precision before insertion and hashing.
- The source app was stopped, 82 uploads copied without overwrites and hash-verified, and HF paused before the final database snapshot. `UPLOAD_DIR` is now configured as `/datav2/uploads`.
- A single-transaction, paginated export of the paused remote libSQL source passed SQLite integrity checks (66 source tables, 96,555,008 bytes). Final source counts: 88 users, 189 channel messages, 438 DMs, 9 servers, 24 channel attachments.
- After the Space rebuild/restart, both Bucket inventories contained the same 82 upload paths with identical sizes and Xet content hashes (zero missing/conflicting files). An existing public avatar URL returned HTTP 200. Production startup logs confirm the native PostgreSQL backend, and Oracle shows the actual HF application's TLS 1.3 connections with client DN `CN=hichat_app`.
- The Micro remained healthy within its 512 MiB container limit. Disk use was 4.6 GiB with approximately 43 GiB free. The hourly backup timer remains enabled. No paid compute or account upgrade was used.

### TLS secrets

HF supplies `HICHAT_PG_CA_PEM`, `HICHAT_PG_CERT_PEM`, and `HICHAT_PG_KEY_PEM` as secrets alongside a PostgreSQL `DATABASE_URL` with `sslmode=verify-full`. pgx loads the PEMs through mode-0600 files in a private temporary directory; those files are removed after the pool is configured. Credentials are never placed in image layers or committed source.

## Credentials and backup recovery

Credentials are not stored in this repository. Server secrets are root-only under `/srv/hichat/secrets`; client TLS material is under `/srv/hichat/client`. The age recovery identity is held outside the repository on the operator machine and was removed from the server after the restore test. Keep that identity in a separate secure recovery location: losing it makes encrypted archives unrecoverable.

`backup.sh` marks success only after `backup-upload` downloads both uploaded archives and verifies their bytes. Remote retention only removes strictly named expired archives in the dedicated backup bucket. It never mirrors application storage with deletion. The service and timer are installed under systemd on the infrastructure host.

## Rehearsal tooling

Build commands from `server/`:

```sh
go build -o pgprobe ./cmd/pgprobe
go build -o migrate-postgres ./cmd/migrate-postgres
go build -o migrate-uploads ./cmd/migrate-uploads
```

`pgprobe` and `migrate-postgres` read `HICHAT_POSTGRES_URL` from the environment. The URL must specify `sslmode=verify-full`, `sslrootcert`, `sslcert` and `sslkey`. Never put credentials in shell history or command arguments.

Run `migrate-postgres --snapshot /secure/offline-snapshot.db` only with a consistent snapshot of the actual source. It copies the snapshot locally, applies current SQLite migrations to the copy, creates a new `hichat_import_<timestamp>` PostgreSQL schema, imports all mapped tables in batches, compares typed row hashes/counts and validates every foreign key before committing. Unknown source tables/columns abort the import. Timestamps are normalized to PostgreSQL microsecond precision before insertion and hashing; IDs, password records and opaque ciphertext remain unchanged. An existing populated import schema cannot be reused. The command prints counts/hashes, not user records. It does not change the application's database URL or enable writes. Review and retain its report.

The local source copy is removed on exit. A failed rehearsal schema remains available for diagnosis; no automatic schema deletion occurs. Synthetic and actual source rehearsals have passed. `export-libsql-snapshot.py` reads the Space's original `DATABASE_URL` from its environment, retains one HTTP transaction through its baton, paginates large tables, preserves rowids and AUTOINCREMENT high-water marks, and writes a private SQLite file on a local filesystem. Do not write SQLite directly onto a Bucket mount.

Run `migrate-uploads` without `-apply` first, inside the actual HF container with both Bucket mounts present. Conflicts abort before copying. `-apply` creates missing files exclusively, never overwrites existing content, checks hashes and rechecks the source inventory. Change `UPLOAD_DIR` to `/datav2/uploads` only after verification during the maintenance window.

## Validation boundaries

The database cutover, real-PG HTTP checks, Bucket restart durability and full production backup restoration above are verified. A long LiveKit call under application load, physical microphone/audio quality, and a complete PostgreSQL run of every repository fixture were not performed in this cutover. Prometheus/Grafana/Uptime Kuma remain deferred under the approved Micro fallback. These broader checks and monitoring should not be described as completed by the evidence above.

Rollback before enabling PostgreSQL writes uses the unchanged source database and original upload configuration. After new writes are accepted, rollback requires a deliberate data reconciliation; merely switching the URL back would lose those new writes.

The Trivy CI step is added to the production image build, but has not yet run in GitHub Actions for this working tree.
