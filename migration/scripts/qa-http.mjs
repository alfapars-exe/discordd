// Disposable fixture transport: destinations and response header names are fixed.
export function apiPath(input) {
  const parsed = new URL(input, 'http://127.0.0.1');
  if (parsed.origin !== 'http://127.0.0.1' || !parsed.pathname.startsWith('/api/')) throw new Error('INVALID_QA_ROUTE');
  const segments = parsed.pathname.slice(5).split('/').map(part => {
    const decoded = decodeURIComponent(part);
    if (!decoded || decoded === '.' || decoded === '..') throw new Error('INVALID_QA_ROUTE');
    return encodeURIComponent(decoded);
  });
  const query = parsed.searchParams.toString();
  return '/api/' + segments.join('/') + (query ? '?' + query : '');
}
export function requestHeaders(headers) {
  const result = {host:'127.0.0.1:19090', origin:'http://localhost'};
  for (const name of ['authorization','content-type','content-length','cookie','x-requested-with','x-csrf-token','x-client-type','x-hichat-client']) {
    if (headers[name] !== undefined) result[name] = headers[name];
  }
  return result;
}
export function responseHeaders(incoming, response) {
  const status = incoming.statusCode;
  // Fixture APIs return JSON, never redirects or arbitrary upstream headers.
  if (!Number.isInteger(status) || status < 200 || status > 599 || (status >= 300 && status < 400)) {
    response.writeHead(502);response.end('Unexpected fixture response');return false;
  }
  response.setHeader('Content-Type','application/json');
  if (incoming.headers['set-cookie']) response.setHeader('Set-Cookie',incoming.headers['set-cookie']);
  response.writeHead(status);return true;
}
