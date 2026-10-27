# Browser E2E

The Playwright suite owns an isolated local test stack. Its Go API binds only
to `127.0.0.1:9090`, uses a newly created SQLite database and uploads folder
under `e2e/.tmp/run-*`, and explicitly clears `DATABASE_URL` so an exported
developer/Turso DSN cannot be used. Vite binds to `localhost:3030` and proxies
the browser API calls to that loopback server. Playwright always starts both
processes; it never reuses an existing server. The launcher pins the API port,
Vite target, and removes hosted-space probe variables from the API child. Do
not replace either server with a running development or P9 service.

Run from `e2e/`:

```powershell
npm ci
npm run test:isolation
npx playwright install chromium
npx playwright test
```

The setup project first registers and logs in the regular E2E account through
the UI, then provisions a separate channel-notification fixture in the same
throwaway database. The fixture includes two generated synthetic users (owner
and invited recipient), a normal `general` channel, a recipient-muted channel,
and a private channel denied `ViewChannel` and `ReadMessages` to the `everyone`
role. The recipient starts opted out; the acceptance spec logs both accounts
in with `loginAsNotificationOwner` / `loginAsNotificationRecipient` from
`tests/helpers.ts`, then changes opt-in through the real settings UI.
After each message, an E2E-only read-only Go probe checks both the committed
message marker and its queue row in the exact disposable SQLite file assigned
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
