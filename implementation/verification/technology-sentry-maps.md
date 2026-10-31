# Private source maps

A VITE_SENTRY_DSN-enabled production build requires SENTRY_AUTH_TOKEN, SENTRY_ORG and SENTRY_PROJECT. Desktop CI reads the token from GitHub secrets and the project/organization/DSN from repository variables. HF and standalone Docker builds read the private values from BuildKit secret mounts under /run/secrets; never pass the token as a build arg or COPY an env file. Configure HF build secrets with the same names before enabling its DSN.

Each build injects Debug IDs into its own JavaScript and uploads its own hidden maps, then removes maps and checks the final output. Desktop and HF builds must never share an uploaded artifact bundle. A missing credential or failed upload rejects the enabled build. Disabled local builds require no credentials and remove public vendor .map files as well.

Validation: production TypeScript/Vite build succeeds without credentials and leaves zero .map files. Enabled build without credentials fails. `node scripts/test-sentry-build.mjs` uses only a loopback 503 fixture and dummy credentials: built JS contains Debug IDs, no sourceMappingURL comment, and failed upload stops the build. Run a disabled build afterward to restore publishable local output. This is not proof of real Sentry symbolication.

External acceptance OPEN: no usable Sentry token/project connection is available in this session. Repository source contains no concrete org/project; connector cannot read Actions variables. A controlled error in each exact deployed artifact must resolve to its source file and line in Sentry before acceptance. No live error was emitted, no maps uploaded, no deployment occurred.

Rollback: revert build plugin/workflow/Docker changes; DSN-off builds continue to work. Never distribute an output left by a failed enabled build. The lockfile retains baseline zod finding until dependency PR #193 is applied; new plugin dependencies add no high/critical finding.
