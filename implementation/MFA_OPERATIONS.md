# MFA operations and rollback boundary

Migrations `090_account_mfa.sql` and `091_mfa_recovery_generation.sql` are additive. Existing accounts remain password-only until they verify an authenticator code. They add encrypted enabled/pending secrets, hashed recovery codes, a replay counter, a shared durable attempt budget and a compare-and-swap generation for concurrent recovery replacement. No SMS is used.

The server implements the SHA-1, six-digit, 30-second RFC 6238 profile, with at most one adjacent time step in either direction. A successful enrollment or verification consumes its time step. Recovery codes contain 128 random bits each; only account-domain-separated SHA-256 hashes are persisted. Setup and code replacement responses are `no-store`; plaintext secrets/codes are not included in general user responses. Setup supports manual entry into authenticator apps; QR scanning is not currently provided.

## Key and database preservation

- Keep the existing configured 32-byte `ENCRYPTION_KEY` stable across restarts. MFA derives an account-bound subkey from it. An arbitrary key change makes existing MFA secrets unreadable; it does not silently disable MFA.
- Back up this key securely alongside the existing database backup procedure. Never put production keys, setup keys or recovery codes into source control or diagnostic reports.
- Database exports containing `account_mfa` must be treated as sensitive even though secrets are encrypted. Restore the database and matching encryption key together. Verify recovery and login against a throwaway account before accepting restoration.
- The durable verification budget is five attempts per account per five-minute window, shared by enrollment, confirmation, login verification, recovery replacement and disabling. A missing-factor login challenge does not consume it. Restarting a server does not reset this budget.
- Each successful code is one-time. Wait for the next authenticator code after enrollment, or use an unused recovery code. Existing authenticated sessions remain active; setup does not secretly log out the user before recovery codes can be saved.

## Rollback

Do not roll back to a server that ignores MFA while any enabled MFA account exists. That would allow password-only login and is not a safe rollback. Keep migration 090 and its data; deploy an MFA-aware previous build or a corrected forward build. If no accounts use MFA, older code can operate with the additive table present, but that path still requires an explicit rollback acceptance test. Do not drop the table or clear enabled secrets as an automated rollback.

Before release, verify backup/restore with a stable key and persistent database, local SQLite and remote libSQL behavior, an actual authenticator application, and Windows/web clients. Unit tests and local HTTP probes are not substitutes for those acceptance checks.
