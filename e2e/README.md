# Browser E2E

The Playwright suite starts its own Go API on `127.0.0.1:9090` and Vite on
`localhost:3030`. Vite proxies browser API calls to that API. Each run
creates a PostgreSQL database and an uploads directory. The launcher replaces
the API child's `DATABASE_URL` with the run database URL and clears
`DATABASE_PATH`. Playwright requires both ports to be free.

Provide `HICHAT_E2E_POSTGRES_DSN` for a disposable PostgreSQL control database
named `hichat_e2e_control` on `127.0.0.1`. The connection uses verified mTLS
and the role must be able to create and drop databases. On Linux with Docker,
Bash and OpenSSL, run `bash scripts/start-e2e-postgres.sh` from the repository
root. It prints the control URL file path and container name. Export the DSN
from that file in the shell that will run Playwright. For GitHub Actions the
script writes the environment variables to `GITHUB_ENV`.

For a voice test, start a disposable LiveKit development server and set
`HICHAT_E2E_LIVEKIT_PORT` to its published loopback signaling port before
starting Playwright. The API then issues tokens for `ws://127.0.0.1:<port>`
using LiveKit's development credentials. Publish the RTC ports on loopback
as well. Ordinary browser runs leave this variable unset.

Install dependencies in both `client/` and `e2e/` with `npm ci`. From `e2e/`
run the isolation checks and the Chromium suite:

```sh
npm run test:isolation
npx playwright install chromium
npx playwright test --project=chromium
```

For the full suite, also install WebKit with `npx playwright install webkit`
and run `npx playwright test`. To reproduce the production WebKit check, set
`HICHAT_E2E_PRODUCTION_CLIENT=1` in the environment and run
`npx playwright test --project=webkit-smoke`. Playwright builds the client
and serves its output on port 3030 with the isolated API proxy.

The setup project first registers and logs in the regular E2E account through
the UI, then provisions a separate channel-notification fixture in the same
throwaway database. The fixture includes two generated synthetic users (owner
and invited recipient), a normal `general` channel, a recipient-muted channel,
and a private channel denied `ViewChannel` and `ReadMessages` to the `everyone`
role. The recipient starts opted out; the acceptance spec logs both accounts
in with `loginAsNotificationOwner` / `loginAsNotificationRecipient` from
`tests/helpers.ts`, then changes opt-in through the real settings UI.
After each message, an E2E-only read-only Go probe checks both the committed
message marker and its queue row in the disposable PostgreSQL database assigned
to this Playwright process. The UI assertions run only after that job is
gone, so a delayed retry cannot look like successful suppression. On a CI
retry, the spec deletes only its synthetic server, whose cascade clears its
messages, jobs, and notification rows, then rebuilds that fixture with the
same recipient.

Generated login credentials and fixture IDs are written to
`.tmp/account.json`, `.tmp/notification-recipient-pending.json`, and
`.tmp/channel-notification-fixture.json`. Those files
are ignored by Git, created with owner-only mode on POSIX, and contain no
access or refresh tokens. On Windows, Node's `0600` mode does not create a
private NTFS ACL; files rely on the current profile's inherited permissions.
The fixture uses synthetic accounts only. Global teardown removes credential
files on normal completion, but an abrupt process kill can leave them under
`.tmp`; remove that ignored directory before sharing the workspace or its
artifacts. The setup does not print passwords or tokens. Playwright traces
are disabled because trace call arguments can retain form/evaluate inputs. The database and
uploads directories stay under the disposable `run-*` tree and old runs are
pruned to the newest three completed runs without removing a live run. Run
`npm run test:isolation` to statically verify
the loopback-only server/proxy contract without opening a browser.

The setup makes no calls to external services: LiveKit, Sentry, email, and
third-party integrations are disabled for the Go process; the server's
self-hosted LiveKit fixture values are inert `.invalid` / test-only values.

The encrypted-history recovery scenario owns a separate run database and account
identities because it changes the account key backup. Run it separately with
`HICHAT_E2E_CRYPTO_RECOVERY=1 HICHAT_E2E_PRODUCTION_CLIENT=1 npx playwright test --project=chromium tests/crypto-recovery.spec.ts`
(PowerShell: set those two environment variables before the command). The normal
Chromium suite excludes this file. CI runs this profile against its owned mTLS
PostgreSQL fixture. It checks ciphertext-only server storage, wrong-password
rejection, restored identity fingerprint, and historical plaintext rendering from
a fresh browser context, including a reload. Listing the test is not evidence
that browser recovery passed.
