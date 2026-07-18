/**
 * resolve-path — Maps app://hichat/<path> URLs onto absolute file paths
 * inside the bundled client/dist directory. Pure function, no I/O — the
 * caller does the fs read after this validates the request.
 *
 * Security bar: this is the only barrier between an evil `app://hichat/`
 * URL and the local disk. Path traversal must be impossible even when
 * combined with URL encoding, backslash tricks, or null bytes. Tests in
 * resolve-path.test.ts pin the current defense.
 */

import path from "node:path";

export const APP_SCHEME = "app:";
export const APP_HOST = "hichat";

export type ResolvedPath =
  | { ok: true; absolutePath: string }
  | { ok: false; reason: string };

/**
 * Resolves an app:// URL to an absolute path under `distRoot`, or returns
 * a rejection reason. The caller is expected to translate a rejection
 * into a 404 response — never leak the reason externally.
 */
export function resolveAppPath(rawUrl: string, distRoot: string): ResolvedPath {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "malformed_url" };
  }

  if (parsed.protocol !== APP_SCHEME) {
    return { ok: false, reason: "wrong_scheme" };
  }
  if (parsed.hostname !== APP_HOST) {
    return { ok: false, reason: "wrong_host" };
  }

  // URL.pathname is already percent-decoded when read as a component,
  // but `decodeURIComponent` here also catches URLs that were double-
  // encoded upstream (`%252e%252e` → `%2e%2e` → `..`).
  let decoded: string;
  try {
    decoded = decodeURIComponent(parsed.pathname);
  } catch {
    return { ok: false, reason: "malformed_encoding" };
  }

  // Null bytes truncate C-string paths on some platforms; reject early.
  if (decoded.includes("\0")) {
    return { ok: false, reason: "null_byte" };
  }

  // Any ".." segment is a rejection — even one that would normalize
  // back inside distRoot. Legitimate asset URLs never contain "..".
  // Node's URL parser already collapses ".." at the origin boundary
  // (so app://hichat/../etc/passwd arrives as /etc/passwd), but a
  // percent-encoded ".." survives that normalization and lands here
  // decoded. Split on both slash types so backslash tricks (Windows)
  // are also caught.
  const segments = decoded.split(/[\\/]/);
  for (const segment of segments) {
    if (segment === ".." || segment === ".") {
      return { ok: false, reason: "traversal" };
    }
  }

  // Empty path or "/" → index.html so the SPA entry point loads.
  const relative = decoded === "" || decoded === "/" ? "/index.html" : decoded;

  const normalized = path.posix.normalize(relative);

  // Strip the leading "/" so path.join treats it as a relative segment.
  const withoutLeadingSlash = normalized.replace(/^\/+/, "");

  // Reject absolute paths and Windows drive letters — a lucky
  // sequence like "app://hichat/C:/Users/..." must not resolve to C:\.
  if (
    path.isAbsolute(withoutLeadingSlash) ||
    /^[a-z]:/i.test(withoutLeadingSlash)
  ) {
    return { ok: false, reason: "absolute_path" };
  }

  const absolute = path.resolve(distRoot, withoutLeadingSlash);
  const normalizedRoot = path.resolve(distRoot);

  // Final containment check: even after all the above filters, verify
  // the resolved path actually sits inside distRoot. This is the
  // belt-and-braces defense against symlinks or a normalizer bug.
  const rel = path.relative(normalizedRoot, absolute);
  if (rel === "" || rel === ".") {
    // Resolved to the distRoot itself — treat as a request for index.html.
    return { ok: true, absolutePath: path.join(normalizedRoot, "index.html") };
  }
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return { ok: false, reason: "escaped_dist_root" };
  }

  return { ok: true, absolutePath: absolute };
}
