import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { localAPIURL, requestLocalAPI } from './local-profile-api.mjs';

async function peer(t, handler) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}

test('fixture API preserves its real routes and bounded history cursor', () => {
  for (const path of ['/api/auth/register', '/api/auth/login', '/api/servers', '/api/servers/join',
    '/api/servers/server-id', '/api/servers/server-id/channels', '/api/servers/server-id/invites',
    '/api/servers/server-id/channels/channel-id/messages?limit=100&before=message-id']) {
    const url = localAPIURL('http://127.0.0.1:12345', path);
    assert.equal(url.origin, 'http://127.0.0.1:12345');
    assert.equal(url.pathname + url.search, path);
  }
});

test('foreign origins, API traversal, encoded separators and query overrides are refused', () => {
  for (const origin of ['https://example.test', 'http://localhost:12345', 'http://user:pass@127.0.0.1:12345',
    'http://127.0.0.1:12345/base', 'http://127.0.0.1:12345/?token=private']) {
    assert.throws(() => localAPIURL(origin, '/api/auth/login'), /Invalid local fixture origin/);
  }
  for (const path of ['//example.test/api/auth/login', 'https://example.test', '/api/servers/a/../join',
    '/api/servers/a%2f..%2fjoin', '/api/servers/a%252fjoin', '/api/servers/a#fragment',
    '/api/auth/login?before=private', '/api/servers/a/channels/b/messages?limit=101',
    '/api/servers/a/channels/b/messages?limit=1&limit=100', '/api/servers/a/channels/b/messages?unknown=value',
    '/api/servers/a/channels/b/messages?limit=1&before=../other']) {
    assert.throws(() => localAPIURL('http://127.0.0.1:12345', path), /Invalid fixture API/);
  }
});

test('real loopback POST retains JSON body, bearer auth and success envelope', async t => {
  const origin = await peer(t, async (request, response) => {
    assert.equal(request.url, '/api/auth/login');
    assert.equal(request.method, 'POST');
    assert.equal(request.headers.authorization, 'Bearer fixture-access');
    let text = '';
    for await (const chunk of request) text += chunk;
    assert.deepEqual(JSON.parse(text), { username: 'fixture-user', password: 'fixture-only' });
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ success: true, data: { id: 'fixture-id' } }));
  });
  assert.deepEqual(await requestLocalAPI(origin, { path: '/api/auth/login', token: 'fixture-access',
    body: { username: 'fixture-user', password: 'fixture-only' } }), { id: 'fixture-id' });
});

test('redirects never send the authenticated fixture request to a second server', async t => {
  let forwarded = 0;
  const destination = await peer(t, (_, response) => { forwarded++; response.end('{}'); });
  const origin = await peer(t, (_, response) => {
    response.writeHead(307, { Location: destination + '/api/auth/login' }); response.end();
  });
  await assert.rejects(requestLocalAPI(origin, { path: '/api/auth/login', token: 'private-fixture-token', body: {} }),
    /^Error: Local fixture transport failed$/);
  assert.equal(forwarded, 0);
});

test('malformed or rejected responses never echo response bodies or tokens', async t => {
  const origin = await peer(t, (_, response) => { response.statusCode = 403; response.end('private-response-content'); });
  await assert.rejects(requestLocalAPI(origin, { path: '/api/auth/login', token: 'private-fixture-token', body: {} }),
    /^Error: Invalid fixture API response$/);
});

test('HTTP failure and unsuccessful JSON envelopes cannot return authentication data', async t => {
  await Promise.all([{ status: 403, success: true }, { status: 200, success: false }].map(async item => {
    const origin = await peer(t, (_, response) => {
      response.statusCode = item.status;
      response.end(JSON.stringify({ success: item.success, data: { access_token: 'private-fixture-token' } }));
    });
    await assert.rejects(requestLocalAPI(origin, { path: '/api/auth/login', body: {} }),
      error => error.message === `Fixture API rejected (status ${item.status})`);
  }));
});
