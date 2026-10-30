# Bundled translation loading

Turkish common/auth/errors are synchronous (errors supports window/global non-React error reporting). Titlebar settings loads before app bootstrap. Public routes load their namespaces before rendering. The authenticated layout preloads all active-language namespaces plus Turkish fallback before synchronous stores/WS callbacks can use them. This deliberately preserves non-React translation semantics; finer authenticated-route splitting is deferred.

Language changes await all active resources, keep existing language/storage on failure, and ignore stale requests. Both main and Electron overlay wait for bootstrap. No network translation service is used: Vite emits local dynamic chunks and existing Electron/Capacitor dist packaging includes them.

Validation: TypeScript, production build, 142 translation/auth/settings/voice/date tests passed. Includes failed chunk loading and overlapping language selection. Bundle comparison is in technology-i18n-bundle-2026-10-30.json (static import closure, same machine/dependencies). Native device acceptance remains separate. Revert this PR to restore eager loading; no persisted preference migration is needed.
