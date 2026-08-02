-- 079 — Badge icons move behind the auth-hardened /api/uploads/ handler.
-- '/uploads/badges/…' was never actually mounted (SPA fallback served
-- index.html), so custom badge icons were broken; the real, hardened
-- serving path is /api/uploads/badges/… (MediaPublic prefix branch).
UPDATE badges SET icon = '/api' || icon
WHERE icon_type = 'custom' AND icon LIKE '/uploads/badges/%';
