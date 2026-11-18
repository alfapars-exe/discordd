/** Build only the fixture's REST routes on its already allocated loopback port. */
export function localAPIURL(origin, path) {
  const base = new URL(origin);
  if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || !base.port ||
    base.username || base.password || base.pathname !== '/' || base.search || base.hash) {
    throw new Error('Invalid local fixture origin');
  }
  if (typeof path !== 'string' || path.length > 4096 || path.includes('#')) throw new Error('Invalid fixture API route');
  const parts = path.split('?');
  const pathname = parts[0];
  const routes = [
    /^\/api\/auth\/(?:register|login)$/,
    /^\/api\/servers(?:\/join)?$/,
    /^\/api\/servers\/[A-Za-z0-9_-]{1,128}(?:\/(?:channels|invites))?$/,
    /^\/api\/servers\/[A-Za-z0-9_-]{1,128}\/channels\/[A-Za-z0-9_-]{1,128}\/messages$/,
  ];
  if (parts.length > 2 || !routes.some(route => route.test(pathname))) throw new Error('Invalid fixture API route');
  const target = new URL(base.origin);
  // Encode each validated segment. No server-provided ID may introduce a route,
  // dot segment, credentials, a fragment or another origin.
  target.pathname = pathname.split('/').map(segment => encodeURIComponent(segment)).join('/');
  const params = new URLSearchParams(parts.slice(1).join(''));
  if (parts.length === 2 && !pathname.endsWith('/messages')) throw new Error('Invalid fixture API query');
  for (const [key, value] of params) {
    if (params.getAll(key).length !== 1 ||
      (key === 'limit' ? !/^(?:[1-9]\d?|100)$/.test(value) : key !== 'before' || !/^[A-Za-z0-9_-]{1,128}$/.test(value))) {
      throw new Error('Invalid fixture API query');
    }
    target.searchParams.set(key, value);
  }
  return target;
}

export async function requestLocalAPI(origin, { path, body, token, method }) {
  const target = localAPIURL(origin, path);
  const verb = method ?? (body === undefined ? 'GET' : 'POST');
  if (!['GET', 'POST', 'PATCH'].includes(verb)) throw new Error('Invalid fixture API method');
  let response;
  try {
    response = await fetch(target, {
      method: verb,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'error', signal: AbortSignal.timeout(10000),
    });
  } catch { throw new Error('Local fixture transport failed'); }
  let payload;
  try { payload = await response.json(); }
  catch { throw new Error('Invalid fixture API response'); }
  if (!response.ok || payload?.success !== true) throw new Error(`Fixture API rejected (status ${response.status})`);
  return payload.data;
}
