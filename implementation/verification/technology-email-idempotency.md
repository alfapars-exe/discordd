# Email provider retry safety

Migration 050 (legacy import fixture 147) is additive. **Stop every old email delivery worker before applying it.** Deploy only the matching new worker after migration. Previously attempted pending/delivering jobs are cancelled and recorded with outcome `review`; never replay them automatically. Fresh jobs prepare normally.

The auxiliary attempt row freezes sender, recipient, subject and final HTML (including unsubscribe proof and unread count) before the first provider call. It stores the stable key, first-attempt time and provider ID. Queue and account deletion cascade to this sensitive row. Never export payloads into logs or incident tickets.

Resend key protection is bounded to 24 hours. The worker stops ten seconds early to cover its send timeout. Ambiguous exhausted attempts and expired protection require operator review. Inspect only job ID, provider key, first_attempt_ms, provider_id and outcome; reconcile with provider records before any manual decision. There is no automatic review replay command. Immutable-payload conflicts are terminal failures.

Validation: local HTTP fixture asserts identical JSON/key and provider ID; service tests simulate lost response and failed DB acknowledgment, frozen unsubscribe proof/summary, expiry and conflict; isolated PostgreSQL tests cover lease ownership, immutable persistence, legacy migration quarantine and account deletion. Existing email tests passed. No live email, database migration or provider acceptance was performed. CI runs race tests; local Windows has no C race toolchain.

Rollback: stop the worker first. Keep the additive table. Do not restart an old worker against pending prepared jobs: it cannot honor provider keys. Cancel/quarantine pending attempts and reconcile provider outcomes before reverting worker code. Migration rollback is neither needed nor automatically run.
