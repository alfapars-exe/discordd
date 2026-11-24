/**
 * Real packaged Windows Electron / loopback Go + LiveKit voice benchmark.
 * Requires the disposable e2e PostgreSQL server fixture, not production.
 * Usage: node scripts/measure-windows-voice.cjs --label before --exe <HiChat.exe>
 *   --run-dir <e2e/.tmp/run-...> --cert-dir <e2e/.tmp/hichat-e2e-pg...> --rounds 20
 * Add --cold-only yes --rounds 5 for fresh-process joins, or --default-noise yes
 * for a separate default-RNNoise functional run (never mix its timing cohort).
 * --phases yes records sanitized native-constructor, signaling, key-admission,
 * capture and PCM milestones. Optional --prepare video-capability is a causal
 * fixture experiment, not product acceptance: report its work separately.
 * Final product measurements must use --prepare none (the default).
 * Additive scenarios, all off by default and not combinable with --cold-only
 * or --sound-only unless noted: --self-switch yes adds member-initiated
 * switches (already connected, clicks the other channel); --recovery
 * full-reconnect|server-leave forces the member's LiveKit connection down
 * through the SDK test hook and measures recovery (server-leave includes the
 * product's first rejoin backoff step and spaces rounds 31 s apart so that
 * backoff never escalates); --self-row yes (any run) adds the acting member's
 * own sidebar row to joins, moves and switches.
 * Profiles and synthetic credentials stay inside the disposable run directory.
 * No traces, tokens, passwords or real user data are written to the report.
 */
const { _electron } = require('../e2e/node_modules/playwright');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const options = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => {
  if (value.startsWith('--')) pairs.push([value.slice(2), all[index + 1]]);
  return pairs;
}, []));
const root = path.resolve(__dirname, '..');
const runDir = path.resolve(options['run-dir'] || '');
const certDir = path.resolve(options['cert-dir'] || '');
const label = options.label;
const rounds = Number(options.rounds || 20);
const coldOnly = options['cold-only'] === 'yes';
const soundOnly = options['sound-only'] === 'yes';
const phasesEnabled = options.phases === 'yes';
const preparation = options.prepare || 'none';
const selfSwitch = options['self-switch'] === 'yes';
const selfRow = options['self-row'] === 'yes';
const recoveryMode = options.recovery || 'none';
if (!['none', 'enumerate', 'peer-connection', 'video-capability', 'video-and-module'].includes(preparation)) throw Error('Invalid preparation experiment');
if (preparation !== 'none' && !phasesEnabled) throw Error('Preparation experiments require --phases yes');
if (preparation === 'video-and-module' && !/^VoiceProvider-[a-zA-Z0-9_-]+\.js$/.test(options['preload-asset'] || '')) throw Error('Use an observed packaged VoiceProvider asset basename');
if (!/^[a-z0-9-]+$/.test(label || '') || !Number.isInteger(rounds) || rounds < 1 || rounds > 50) throw Error('Invalid benchmark label or round count');
if (!runDir.startsWith(path.join(root, 'e2e', '.tmp') + path.sep) || !/^run-\d+-\d+-[a-f0-9]{16}$/.test(path.basename(runDir))) throw Error('Use a disposable e2e run directory');
if (!fs.existsSync(options.exe || '') || !fs.existsSync(path.join(certDir, 'server.crt'))) throw Error('Executable or fixture certificate missing');
if (!['none', 'full-reconnect', 'server-leave'].includes(recoveryMode)) throw Error('Invalid recovery scenario');
if ((coldOnly || soundOnly) && (selfSwitch || recoveryMode !== 'none')) throw Error('Self-switch and recovery scenarios require the full warm run');
const apiOrigin = 'http://127.0.0.1:9090';
const tlsOrigin = 'https://127.0.0.1:9443';
const fixtureFile = path.join(runDir, 'voice-synthetic-fixture.json');
const reportFile = path.join(runDir, `voice-${label}.json`);
const report = { label, rounds, coldOnly, soundOnly, executable: path.resolve(options.exe), fixture: 'loopback Go9090 / LiveKit17880 / TLS9443',
  measurement: 'real UI actions; token fetch wall time; remote participant list (server-confirmed row, an optimistic pending row is ignored); decoded remote-track WebAudio PCM RMS plus RTP counters; rendered event cue PCM downstream of actual gain before OS output',
  pcmProbe: { pollIntervalMs: 40, analyserFFTSize: 2048, positiveRmsThreshold: 0.0001 },
  limitations: ['Chromium fake microphone with bundled licensed FLEURS speech fixture; --mute-audio suppresses physical speaker output', 'Hidden test windows; local network only; no claim about WAN or physical audio-device latency', 'Non-loopback STUN/TURN endpoints filtered in the fixture; restricted-network/TURN paths are untested'],
  joins: [], moves: [], deafenedMove: null, failures: [] };
report.phaseInstrumentation = { enabled: phasesEnabled, clock: 'Unix milliseconds, rebased to actual DOM action', payloads: 'only event kinds, booleans, durations and ordinal IDs; no keys, SDP, JWTs or participant identities' };
report.preparationExperiment = { mode: preparation, measurements: [], note: 'Optional fixture-only preparation before first channel click, after authenticated UI ready; no capture or offer. Preparation work is reported separately, not hidden in click latency.' };
// Additive scenarios never touch the default report: every key below exists
// only when its option was requested.
const recoveryMetrics = ['connectionMs', 'decodedAudioMs', 'decodedSamplesMs', 'roomLostMs', 'roomRestoredMs', 'ownerResubscribedMs', 'ownerDecodedAudioMs'];
if (selfSwitch || selfRow || recoveryMode !== 'none') report.additionalScenarios = {
  selfSwitch: selfSwitch ? 'member already connected to one channel clicks the other while the owner publishes there; origin and milestones as for joins (member DOM click, owner sidebar, decoded PCM on the new transport)' : null,
  selfRow: selfRow ? 'selfListMs: first 40 ms poll in which the acting member\'s own renderer shows its own row under the destination channel, same origin as listMs; awaited for at most 10 s after decoded audio and null when not seen; a row already visible before the action is reported as invalidated instead of failing the run' : null,
  recovery: recoveryMode === 'none' ? null : { mode: recoveryMode,
    origin: 'member renderer call to the LiveKit SDK test hook room.simulateScenario(mode); no network fault is injected, so ICE or signaling timeout detection is not part of the sample',
    path: recoveryMode === 'full-reconnect' ? 'SDK closes signaling and its transports and rejoins on the current token; the product re-admits encryption on the same Room'
      : 'SFU-initiated leave; the product auto-rejoin owns recovery, so every sample includes its fixed first backoff step, a token refresh and a new Room; rounds are spaced 31 s apart to stay on that first step',
    milestones: { 'connectionMs, decodedAudioMs, decodedSamplesMs': 'as for joins, on transports created after the forced call',
      'roomLostMs, roomRestoredMs': 'member renderer: admitted Room withdrawn, then exposed again after encrypted re-admission (40 ms poll)',
      ownerResubscribedMs: 'owner Room re-subscribed to the member microphone',
      ownerDecodedAudioMs: 'first positive decoded PCM in the owner renderer after that re-subscription (40 ms poll)',
      waits: 'only the member decoded PCM is required; the other milestones are bounded waits and null when not observed' } },
};
if (selfSwitch) report.selfSwitches = [];
if (recoveryMode !== 'none') report.recoveries = [];
const apps = [];
const servers = [];
const delayedTokens = [];

function saveReport() { fs.writeFileSync(reportFile, JSON.stringify(report, null, 2)); }
function secretFile(filename, content) {
  fs.writeFileSync(filename, '', { flag: 'wx', mode: 0o600 });
  if (process.platform === 'win32') {
    const sys = path.join(process.env.SystemRoot, 'System32');
    const sid = execFileSync(path.join(sys, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8' }).match(/S-1-[\d-]+/)[0];
    execFileSync(path.join(sys, 'icacls.exe'), [filename, '/inheritance:r', '/grant:r', `*${sid}:(F)`], { stdio: 'ignore' });
  }
  fs.writeFileSync(filename, JSON.stringify(content), { mode: 0o600 });
}
async function api(route, token, method = 'GET', body) {
  if (!/^\/[a-zA-Z0-9/_-]+$/.test(route)) throw Error('Invalid fixture API route');
  const response = await fetch(`${apiOrigin}/api${route}`, { method, redirect: 'error', signal: AbortSignal.timeout(20_000),
    headers: { 'Content-Type': 'application/json', 'X-HiChat-Client': 'web', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  let envelope;
  try { envelope = await response.json(); } catch { throw Error(`Fixture API ${method} ${route}: ${response.status} non-JSON`); }
  if (!response.ok || !envelope.success) throw Error(`Fixture API ${method} ${route}: ${response.status}`);
  return envelope.data;
}
async function fixture() {
  const makeAccount = displayName => ({ username: `voice_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`, password: `Aa1!${crypto.randomBytes(16).toString('hex')}`, displayName });
  const data = fs.existsSync(fixtureFile) ? JSON.parse(fs.readFileSync(fixtureFile, 'utf8'))
    : { owner: makeAccount('Voice Bench Owner'), member: makeAccount('Voice Bench Member'), channels: [] };
  if (!fs.existsSync(fixtureFile)) secretFile(fixtureFile, data);
  const persist = () => fs.writeFileSync(fixtureFile, JSON.stringify(data), { mode: 0o600 });
  const { owner, member } = data;
  const register = account => api('/auth/register', '', 'POST', { username: account.username, password: account.password, display_name: account.displayName, email: `${account.username}@example.test` });
  const authenticate = async account => {
    try { return await api('/auth/login', '', 'POST', { username: account.username, password: account.password }); }
    catch (error) { if (!error.message.includes(': 401')) throw error; return register(account); }
  };
  const ownerAuth = await authenticate(owner), memberAuth = await authenticate(member);
  owner.id = ownerAuth.user.id; member.id = memberAuth.user.id;
  persist();
  const noiseReduction = options['default-noise'] === 'yes';
  for (const auth of [ownerAuth, memberAuth]) await api('/users/me/preferences', auth.access_token, 'PATCH', {
    expected_user_id: auth.user.id, data: { voice_settings: { noiseReduction } },
  });
  report.audioCondition = { noiseReduction, microphoneProfile: 'speech', input: 'looped active speech segment 10.3–11.3 seconds; no long source silence' };
  if (data.ready) return data;
  const server = data.server || await api('/servers', ownerAuth.access_token, 'POST', { name: 'Windows Voice Benchmark', host_type: 'self_hosted', livekit_url: 'ws://127.0.0.1:17880', livekit_key: 'devkey', livekit_secret: 'secret' });
  data.server = { id: server.id, name: server.name }; persist();
  const groups = await api(`/servers/${server.id}/channels`, ownerAuth.access_token);
  const category = groups[0]?.category?.id || '';
  for (const name of ['bench-alpha', 'bench-beta']) if (!data.channels.some(channel => channel.name === name)) {
    const channel = await api(`/servers/${server.id}/channels`, ownerAuth.access_token, 'POST', { name, type: 'voice', category_id: category });
    data.channels.push({ id: channel.id, name: channel.name }); persist();
  }
  if (!data.joined) {
    const invite = await api(`/servers/${server.id}/invites`, ownerAuth.access_token, 'POST', { max_uses: 1, expires_in: 30, channel_id: data.channels[0].id });
    await api('/servers/join', memberAuth.access_token, 'POST', { invite_code: invite.code });
    data.joined = true; persist();
  }
  for (const auth of [ownerAuth, memberAuth]) await api('/users/me/profile', auth.access_token, 'PATCH', { language: 'en', has_seen_welcome: true, has_seen_download_prompt: true });
  data.ready = true; persist();
  return data;
}
async function listen(server, port) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  servers.push(server);
}
async function startProxy() {
  const key = fs.readFileSync(path.join(certDir, 'server.key')), cert = fs.readFileSync(path.join(certDir, 'server.crt'));
  const spki = crypto.createHash('sha256').update(new crypto.X509Certificate(cert).publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
  const proxy = https.createServer({ key, cert }, (request, response) => {
    const forward = () => {
    const upstream = http.request({ host: '127.0.0.1', port: 9090, path: request.url, method: request.method,
      headers: { ...request.headers, host: '127.0.0.1:9090', 'x-forwarded-proto': 'https' } }, reply => { response.writeHead(reply.statusCode, reply.headers); reply.pipe(response); });
    upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
    request.on('aborted', () => upstream.destroy());
    request.pipe(upstream);
    };
    if (request.headers['x-hichat-benchmark-delay'] === '1' && /\/voice\/token$/.test(request.url)) {
      const delay = { arrivedAt: Date.now(), releasedAt: null, closedAt: null, cancelledBeforeRelease: false };
      delayedTokens.push(delay);
      const timer = setTimeout(() => { delay.releasedAt = Date.now(); forward(); }, 5000);
      response.once('close', () => { delay.closedAt = Date.now(); delay.cancelledBeforeRelease = delay.releasedAt === null; if (delay.cancelledBeforeRelease) clearTimeout(timer); });
    } else forward();
  });
  proxy.on('upgrade', (request, socket, head) => {
    const upstream = http.request({ host: '127.0.0.1', port: 9090, path: request.url, headers: { ...request.headers, host: '127.0.0.1:9090', 'x-forwarded-proto': 'https' } });
    upstream.on('upgrade', (reply, remote, remoteHead) => {
      socket.write(`HTTP/1.1 ${reply.statusCode} Switching Protocols\r\n` + Object.entries(reply.headers).map(([k, v]) => `${k}: ${v}\r\n`).join('') + '\r\n');
      if (head.length) remote.write(head); if (remoteHead.length) socket.write(remoteHead);
      remote.pipe(socket); socket.pipe(remote);
      socket.on('error', () => remote.destroy()); remote.on('error', () => socket.destroy());
    });
    upstream.on('response', reply => { socket.end(`HTTP/1.1 ${reply.statusCode} Rejected\r\n\r\n`); });
    upstream.on('error', () => socket.destroy()); upstream.end();
  });
  await listen(proxy, 9443);
  // Every non-loopback HTTP(S) attempt, including app startup and update checks,
  // is rejected locally. Chromium's explicit loopback bypass reaches our fixture.
  const deny = http.createServer((_request, response) => { response.writeHead(403); response.end(); });
  deny.on('connect', (_request, socket) => socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'));
  await listen(deny, 9444);
  return spki;
}
function microphoneFile() {
  const filename = path.join(runDir, 'fixture-speech-pcm16.wav');
  const original = fs.readFileSync(path.join(root, 'client/public/audio-test-fixtures/turkish-fleurs-original.wav'));
  let input;
  for (let offset = 12; offset + 8 < original.length;) {
    const size = original.readUInt32LE(offset + 4);
    if (original.toString('ascii', offset, offset + 4) === 'data') { input = original.subarray(offset + 8, offset + 8 + size); break; }
    offset += 8 + size + (size % 2);
  }
  if (!input || original.readUInt16LE(20) !== 3 || original.readUInt16LE(22) !== 1) throw Error('Expected bundled float32 mono FLEURS fixture');
  const rate = original.readUInt32LE(24);
  input = input.subarray(Math.round(10.3 * rate) * 4, Math.round(11.3 * rate) * 4);
  const samples = input.length / 4;
  const data = Buffer.alloc(44 + samples * 2);
  data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8); data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22); data.writeUInt32LE(rate, 24); data.writeUInt32LE(rate * 2, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) {
    const value = Math.max(-1, Math.min(1, input.readFloatLE(i * 4)));
    data.writeInt16LE(Math.round(value * 32767), 44 + 2 * i);
  }
  report.microphoneFixture = { source: 'client/public/audio-test-fixtures/turkish-fleurs-original.wav', license: 'CC BY 4.0; attribution in adjacent README.md', conversion: 'active segment 10.3–11.3s; float32 mono to PCM16 mono, original sample rate; Chromium loops this 1s segment', sha256: crypto.createHash('sha256').update(data).digest('hex') };
  fs.writeFileSync(filename, data); return filename;
}
function instrument({ origin, ownId, otherId, channels, phasesEnabled, ownName, selfRowEnabled, recoveryEnabled }) {
  localStorage.setItem('mqvi_server_url', origin);
  localStorage.setItem('i18nextLng', 'en');
  localStorage.setItem('language', 'en');
  const state = { start: 0, actionAt: null, minPC: 0, action: '', token: [], ws: [], pcs: [], pcm: [], cues: [], phases: [], longTasks: [], captures: 0, capabilityQueries: [], preActionActivity: null, listAt: null, decodedAt: null, decodedSamplesAt: null, lastEnergy: new Map(), lastStats: [], connectionAt: null, delayNextToken: false, filteredIce: [] };
  const phase = (name, data = {}) => { if (phasesEnabled && state.start) state.phases.push({ name, at: Date.now(), sincePreparationMs: Date.now() - state.start, ...data }); };
  // Milestones of the optional self-row and recovery scenarios; reported only on request.
  const resetAdditions = () => Object.assign(state, { selfListAt: null, roomLostAt: null, roomRestoredAt: null, resubscribedAt: null, remoteHeardAt: null });
  resetAdditions();
  let probeContextConstruction = false;
  const bufferUrls = new WeakMap(), decodedUrls = new WeakMap();
  window.__voiceBench = { state, mark(action, start, target) {
    state.start = start; state.actionAt = null; state.preActionActivity = null; state.minPC = state.pcs.length; state.lastEnergy.clear(); state.action = action; state.target = target; state.token = []; state.ws = []; state.cues = []; state.phases = []; state.longTasks = []; state.listAt = null; state.decodedAt = null; state.decodedSamplesAt = null; state.connectionAt = null;
    resetAdditions();
  }, result() {
    const room = window.__hichatRoom, mic = room?.localParticipant.getTrackPublication('microphone');
    return { preparedAt: state.start, actionAt: state.actionAt, preActionActivity: state.preActionActivity, capabilityQueries: state.capabilityQueries, listAt: state.listAt, decodedAt: state.decodedAt, decodedSamplesAt: state.decodedSamplesAt, connectionAt: state.connectionAt, token: state.token, ws: state.ws, cues: state.cues, phases: state.phases, longTasks: state.longTasks, lastStats: state.lastStats, filteredIce: state.filteredIce, pcm: state.pcm.filter(probe => probe.pc >= state.minPC).map(probe => ({ pc: probe.pc, maxRms: probe.maxRms, state: probe.context.state })),
      room: room ? { state: room.state, canPlaybackAudio: room.canPlaybackAudio, microphone: mic ? { muted: mic.isMuted, enabled: mic.track?.mediaStreamTrack?.enabled, pipeline: mic.track?.processor?.pipeline?.getStatus() } : null,
        remotes: Array.from(room.remoteParticipants.values()).map(peer => ({ microphone: Array.from(peer.trackPublications.values()).filter(pub => pub.source === 'microphone').map(pub => ({ subscribed: pub.isSubscribed, muted: pub.isMuted, trackPresent: !!pub.track })) })) } : null,
      peerConnections: state.pcs.slice(state.minPC).map(pc => ({ state: pc.connectionState, senders: pc.getSenders().map(s => ({ kind: s.track?.kind, enabled: s.track?.enabled, ready: s.track?.readyState })) })),
      ...(selfRowEnabled ? { selfListAt: state.selfListAt } : {}) };
  } };
  if (recoveryEnabled) Object.assign(window.__voiceBench, {
    // There is no DOM action to anchor a recovery, so its origin is the call
    // that makes the SDK drop the admitted Room's signaling and transports.
    async forceDisconnect(scenario) {
      const room = window.__hichatRoom;
      if (room?.state !== 'connected' || typeof room.simulateScenario !== 'function') throw Error('No connected room to disconnect');
      state.actionAt = Date.now();
      state.preActionActivity = { captureRequests: state.captures, peerConnectionsCreated: state.pcs.length, roomExposed: true };
      phase('forced_disconnect', { scenario });
      await room.simulateScenario(scenario);
    },
    observeResubscription() {
      const room = window.__hichatRoom;
      if (!room?.on) throw Error('No admitted room to observe');
      state.stopResubscription?.();
      const subscribed = (_track, publication) => { if (publication.source === 'microphone') state.resubscribedAt ||= Date.now(); };
      room.on('trackSubscribed', subscribed);
      state.stopResubscription = () => room.off('trackSubscribed', subscribed);
    },
    recovery() {
      state.stopResubscription?.(); state.stopResubscription = null;
      return { roomLostAt: state.roomLostAt, roomRestoredAt: state.roomRestoredAt, resubscribedAt: state.resubscribedAt, remoteHeardAt: state.remoteHeardAt };
    },
  });
  const actionStart = event => {
    if (!state.start || state.actionAt) return;
    const target = event.target.closest?.(`[data-keyboard-reorder-id="${state.target}"]`);
    if (target && ((event.type === 'click' && ['join', 'switch'].includes(state.action)) || (event.type === 'drop' && state.action.includes('move')))) {
      state.actionAt = Date.now();
      state.preActionActivity = { captureRequests: state.captures, peerConnectionsCreated: state.pcs.length, roomExposed: !!window.__hichatRoom };
      phase('dom_action', { event: event.type });
    }
  };
  document.addEventListener('click', actionStart, true);
  document.addEventListener('drop', actionStart, true);
  if (phasesEnabled) {
    let observedRoom, removeRoomObservation = () => {};
    Object.defineProperty(window, '__hichatRoom', { configurable: true,
      get: () => observedRoom,
      set: room => {
        if (room === observedRoom) return;
        removeRoomObservation(); observedRoom = room;
        if (!room?.on) { removeRoomObservation = () => {}; return; }
        phase('room_exposed_after_admission');
        const published = publication => { if (publication.source === 'microphone') phase('microphone_published'); };
        const subscribed = (_track, publication) => { if (publication.source === 'microphone') phase('remote_microphone_subscribed'); };
        room.on('localTrackPublished', published); room.on('trackSubscribed', subscribed);
        removeRoomObservation = () => { room.off('localTrackPublished', published); room.off('trackSubscribed', subscribed); };
      },
    });
    if (window.VideoEncoder?.isConfigSupported) {
      const check = VideoEncoder.isConfigSupported;
      VideoEncoder.isConfigSupported = function(configuration) {
        const startedAt = Date.now(), start = performance.now();
        const pending = check.call(this, configuration);
        const query = { startedAt, callReturnMs: performance.now() - start, completedAt: null, durationMs: null, supported: null };
        state.capabilityQueries.push(query);
        return pending.then(result => { query.completedAt = Date.now(); query.durationMs = query.completedAt - startedAt; query.supported = result.supported; return result; }, error => { query.completedAt = Date.now(); query.durationMs = query.completedAt - startedAt; query.error = error.name; throw error; });
      };
    }
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) if (state.start && performance.timeOrigin + entry.startTime + entry.duration >= state.start)
        state.longTasks.push({ at: performance.timeOrigin + entry.startTime, durationMs: entry.duration });
    }).observe({ type: 'longtask', buffered: true });
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        if (!state.start || performance.timeOrigin + entry.startTime < state.start) continue;
        const resource = new URL(entry.name, location.href);
        if (resource.protocol !== 'app:' || !/\.(js|wasm)$/.test(resource.pathname)) continue;
        phase('resource_ready', { asset: resource.pathname.split('/').pop(),
          resourceStartAt: performance.timeOrigin + entry.startTime,
          resourceResponseEndAt: performance.timeOrigin + entry.responseEnd,
          durationMs: entry.duration, transferSize: entry.transferSize });
      }
    }).observe({ type: 'resource', buffered: true });
    const debug = console.debug;
    console.debug = function(...args) {
      if (args[0] === '[voice] microphone permission resolved') phase('permission_resolved', { elapsedMs: args[1]?.elapsedMs });
      if (args[0] === '[voice] join token ready') phase('token_committed', { elapsedMs: args[1]?.elapsedMs });
      return debug.apply(this, args);
    };
    const getUserMedia = navigator.mediaDevices.getUserMedia;
    let captureId = 0;
    navigator.mediaDevices.getUserMedia = async function(constraints) {
      state.captures++;
      const capture = ++captureId, begin = Date.now();
      phase('capture_start', { capture, audio: !!constraints?.audio, video: !!constraints?.video });
      try { const result = await getUserMedia.call(this, constraints); phase('capture_ready', { capture, durationMs: Date.now() - begin }); return result; }
      catch (error) { phase('capture_error', { capture, durationMs: Date.now() - begin, error: error.name }); throw error; }
    };
    const OriginalWorker = window.Worker;
    let workerId = 0;
    window.Worker = class extends OriginalWorker {
      constructor(...args) {
        const begin = Date.now(), isE2ee = /e2ee/i.test(String(args[0]));
        if (isE2ee) phase('e2ee_worker_constructor_start');
        super(...args); this.__benchId = ++workerId;
        this.__benchE2ee = /e2ee/i.test(String(args[0]));
        if (this.__benchE2ee) {
          phase('e2ee_worker_created', { worker: this.__benchId, durationMs: Date.now() - begin });
          this.addEventListener('message', event => this.__benchMessage('receive', event.data));
          this.addEventListener('error', () => phase('e2ee_worker_error', { worker: this.__benchId }));
        }
      }
      __benchMessage(direction, message) {
        if (this.__benchE2ee && ['init', 'initAck', 'setKey', 'enable', 'encode', 'decode', 'error'].includes(message?.kind))
          phase(`e2ee_${direction}_${message.kind}`, { worker: this.__benchId,
            ...(message.kind === 'enable' ? { enabled: message.data?.enabled === true, admissionRequest: typeof message.data?.hichatRequestId === 'string' } : {}) });
      }
      postMessage(message, ...args) { this.__benchMessage('send', message); return super.postMessage(message, ...args); }
    };
    const OriginalAudioContext = window.AudioContext;
    let audioContextId = 0;
    window.AudioContext = class extends OriginalAudioContext {
      constructor(...args) {
        const begin = Date.now(), context = ++audioContextId, probe = probeContextConstruction;
        phase('audio_context_constructor_start', { context, probe });
        super(...args); this.__benchId = context; this.__benchProbe = probe;
        phase('audio_context_created', { context, probe, durationMs: Date.now() - begin, state: this.state });
      }
      async resume() {
        const begin = Date.now(); phase('audio_context_resume_start', { context: this.__benchId, probe: this.__benchProbe });
        try { const result = await super.resume(); phase('audio_context_resume_ready', { context: this.__benchId, probe: this.__benchProbe, durationMs: Date.now() - begin }); return result; }
        catch (error) { phase('audio_context_resume_error', { context: this.__benchId, error: error.name }); throw error; }
      }
      async setSinkId(...args) {
        const begin = Date.now(); phase('audio_context_sink_start', { context: this.__benchId });
        try { const result = await super.setSinkId(...args); phase('audio_context_sink_ready', { context: this.__benchId, durationMs: Date.now() - begin }); return result; }
        catch (error) { phase('audio_context_sink_error', { context: this.__benchId, error: error.name }); throw error; }
      }
    };
    if (window.AudioWorklet?.prototype.addModule) {
      const addModule = AudioWorklet.prototype.addModule;
      AudioWorklet.prototype.addModule = async function(...args) {
        const begin = Date.now(); phase('audio_worklet_module_start');
        try { const result = await addModule.apply(this, args); phase('audio_worklet_module_ready', { durationMs: Date.now() - begin }); return result; }
        catch (error) { phase('audio_worklet_module_error', { error: error.name }); throw error; }
      };
    }
    for (const operation of ['importKey', 'deriveKey', 'deriveBits']) {
      const original = crypto.subtle[operation];
      crypto.subtle[operation] = async function(...args) {
        const algorithm = operation === 'importKey' ? args[2] : args[0];
        const name = typeof algorithm === 'string' ? algorithm : algorithm?.name;
        const safeName = ['PBKDF2', 'HKDF', 'AES-GCM', 'ECDH', 'ECDSA', 'HMAC', 'Ed25519', 'X25519'].includes(name) ? name : 'other';
        const begin = Date.now(); phase(`crypto_${operation}_start`, { algorithm: safeName });
        try { const result = await original.apply(this, args); phase(`crypto_${operation}_ready`, { algorithm: safeName, durationMs: Date.now() - begin }); return result; }
        catch (error) { phase(`crypto_${operation}_error`, { algorithm: safeName, error: error.name }); throw error; }
      };
    }
  }
  const fetch = window.fetch;
  window.fetch = async function(input, init) {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href), start = Date.now();
    if (/\/voice\/token$/.test(url.pathname)) phase('token_fetch_start');
    if (/\/voice\/token$/.test(url.pathname) && state.delayNextToken) {
      state.delayNextToken = false;
      const headers = new Headers(init?.headers || (typeof input !== 'string' ? input.headers : undefined));
      headers.set('x-hichat-benchmark-delay', '1'); init = { ...init, headers };
    }
    let response;
    try { response = await fetch.call(this, input, init); }
    catch (error) { if (/\/voice\/token$/.test(url.pathname)) { phase('token_fetch_error', { error: error.name }); state.token.push({ durationMs: Date.now() - start, sincePreparationMs: Date.now() - state.start, status: 0, aborted: error.name === 'AbortError' }); } throw error; }
    if (/\/voice\/token$/.test(url.pathname)) { phase('token_fetch_ready', { status: response.status }); state.token.push({ durationMs: Date.now() - start, sincePreparationMs: Date.now() - state.start, status: response.status, serverTiming: response.headers.get('server-timing') }); }
    if (/\.(m4a|wav|mp3)$/.test(url.pathname)) {
      const arrayBuffer = response.arrayBuffer.bind(response);
      response.arrayBuffer = async () => { const buffer = await arrayBuffer(); bufferUrls.set(buffer, url.pathname.split('/').pop()); return buffer; };
    }
    return response;
  };
  const decode = BaseAudioContext.prototype.decodeAudioData;
  BaseAudioContext.prototype.decodeAudioData = function(buffer, ...args) {
    const promise = decode.call(this, buffer, ...args);
    if (promise?.then) void promise.then(decoded => { if (bufferUrls.has(buffer)) decodedUrls.set(decoded, bufferUrls.get(buffer)); }).catch(() => {});
    return promise;
  };
  const OriginalPC = window.RTCPeerConnection;
  const localIce = configuration => {
    if (!configuration) return configuration;
    return { ...configuration, iceServers: (configuration.iceServers || []).flatMap(server => {
      const urls = [server.urls].flat().filter(url => {
        const host = String(url).replace(/^(stun|stuns|turn|turns):\/{0,2}/, '').split(/[/:?]/)[0];
        if (host === '127.0.0.1' || host === 'localhost') return true;
        if (!state.filteredIce.includes(host)) state.filteredIce.push(host);
        return false;
      });
      return urls.length ? [{ ...server, urls }] : [];
    }) };
  };
  window.RTCPeerConnection = class extends OriginalPC {
    constructor(configuration, ...args) {
      const begin = Date.now(), pc = state.pcs.length; phase('pc_constructor_start', { pc });
      super(localIce(configuration), ...args); state.pcs.push(this);
      phase('pc_created', { pc, durationMs: Date.now() - begin, iceGatheringState: this.iceGatheringState });
      const measuredTracks = new WeakSet();
      this.addEventListener('connectionstatechange', () => { phase('pc_connection_state', { pc, state: this.connectionState }); if (this.connectionState === 'connected' && state.start && state.pcs.indexOf(this) >= state.minPC) state.connectionAt ||= Date.now(); });
      this.addEventListener('iceconnectionstatechange', () => phase('pc_ice_connection_state', { pc, state: this.iceConnectionState }));
      this.addEventListener('icegatheringstatechange', () => phase('pc_ice_gathering_state', { pc, state: this.iceGatheringState }));
      this.addEventListener('signalingstatechange', () => phase('pc_signaling_state', { pc, state: this.signalingState }));
      let firstCandidate = false;
      this.addEventListener('icecandidate', event => { if (event.candidate && !firstCandidate) { firstCandidate = true; phase('pc_first_ice_candidate', { pc, type: event.candidate.type, protocol: event.candidate.protocol }); } });
      this.addEventListener('track', event => {
        if (event.track.kind !== 'audio' || measuredTracks.has(event.track)) return;
        phase('pc_audio_track_received', { pc });
        measuredTracks.add(event.track);
        let context;
        probeContextConstruction = true;
        try { context = new AudioContext(); } finally { probeContextConstruction = false; }
        const source = context.createMediaStreamSource(new MediaStream([event.track]));
        const analyser = context.createAnalyser(), silent = context.createGain(); silent.gain.value = 0;
        source.connect(analyser); analyser.connect(silent); silent.connect(context.destination);
        const probe = { pc: state.pcs.indexOf(this), context, source, analyser, samples: new Float32Array(analyser.fftSize), maxRms: 0 };
        state.pcm.push(probe); void context.resume();
        this.addEventListener('connectionstatechange', () => { if (this.connectionState === 'closed') void context.close(); });
      });
    }
    async createOffer(...args) { const begin = Date.now(), pc = state.pcs.indexOf(this); phase('pc_create_offer_start', { pc }); const value = await super.createOffer(...args); phase('pc_create_offer_ready', { pc, durationMs: Date.now() - begin }); return value; }
    async createAnswer(...args) { const begin = Date.now(), pc = state.pcs.indexOf(this); phase('pc_create_answer_start', { pc }); const value = await super.createAnswer(...args); phase('pc_create_answer_ready', { pc, durationMs: Date.now() - begin }); return value; }
    async setLocalDescription(...args) { const begin = Date.now(), pc = state.pcs.indexOf(this); phase('pc_set_local_start', { pc, type: args[0]?.type }); const value = await super.setLocalDescription(...args); phase('pc_set_local_ready', { pc, durationMs: Date.now() - begin }); return value; }
    async setRemoteDescription(...args) { const begin = Date.now(), pc = state.pcs.indexOf(this); phase('pc_set_remote_start', { pc, type: args[0]?.type }); const value = await super.setRemoteDescription(...args); phase('pc_set_remote_ready', { pc, durationMs: Date.now() - begin }); return value; }
    setConfiguration(configuration) { return super.setConfiguration(localIce(configuration)); }
    close() {
      for (const probe of state.pcm) if (probe.pc === state.pcs.indexOf(this) && probe.context.state !== 'closed') {
        probe.source.disconnect(); probe.analyser.disconnect(); void probe.context.close().catch(() => {});
      }
      return super.close();
    }
  };
  const OriginalWS = window.WebSocket;
  window.WebSocket = class extends OriginalWS {
    constructor(...args) {
      const target = new URL(args[0], location.href), livekit = target.pathname.startsWith('/rtc');
      if (livekit) phase('livekit_websocket_start');
      super(...args);
      if (livekit) {
        phase('livekit_websocket_created');
        this.addEventListener('open', () => phase('livekit_websocket_open'));
        let firstMessage = false;
        this.addEventListener('message', () => { if (!firstMessage) { firstMessage = true; phase('livekit_websocket_first_message'); } });
        this.addEventListener('error', () => phase('livekit_websocket_error'));
      }
      if (new URL(args[0], location.href).pathname === '/ws') this.addEventListener('message', event => {
        try { const message = JSON.parse(event.data); if (message.op.startsWith('voice_')) state.ws.push({ op: message.op, action: message.d?.action || null, sincePreparationMs: Date.now() - state.start, self: message.d?.user_id === ownId, channel: channels.find(c => c.id === message.d?.channel_id)?.name || null, ...(message.d?.voice ? { embeddedCredentials: true } : {}) }); } catch {}
      });
    }
  };
  const edges = new WeakMap(), connect = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function(node, ...args) { if (node instanceof AudioNode) { const nodes = edges.get(this) || []; nodes.push(node); edges.set(this, nodes); } return connect.call(this, node, ...args); };
  const start = AudioBufferSourceNode.prototype.start;
  AudioBufferSourceNode.prototype.start = function(...args) {
    if (state.start && this.buffer && !this.loop && this.buffer.duration < 5) {
      const outputPath = (node, seen = new Set()) => { if (seen.has(node)) return null; seen.add(node); if (node === this.context.destination) return [node]; for (const next of edges.get(node) || []) { const value = outputPath(next, seen); if (value) return [node, ...value]; } return null; };
      const route = outputPath(this);
      const cue = { sincePreparationMs: Date.now() - state.start, duration: this.buffer.duration, asset: decodedUrls.get(this.buffer) || null, contextState: this.context.state, renderedPeakRms: 0, gainAfterAudioQuantum: null, samples: 0 };
      state.cues.push(cue);
      if (route?.length > 1) {
        const output = route[route.length - 2], analyser = this.context.createAnalyser(), silent = this.context.createGain();
        silent.gain.value = 0; output.connect(analyser); analyser.connect(silent); silent.connect(this.context.destination);
        const samples = new Float32Array(analyser.fftSize);
        const timer = setInterval(() => {
          analyser.getFloatTimeDomainData(samples);
          cue.renderedPeakRms = Math.max(cue.renderedPeakRms, Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length));
          cue.gainAfterAudioQuantum = route.reduce((gain, node) => gain * (node instanceof GainNode ? node.gain.value : 1), 1);
          cue.samples++;
        }, 40);
        setTimeout(() => { clearInterval(timer); try { output.disconnect(analyser); analyser.disconnect(); silent.disconnect(); } catch {} }, this.buffer.duration * 1000 + 100);
      }
    }
    return start.apply(this, args);
  };
  setInterval(async () => {
    if (!state.start) return;
    const now = Date.now();
    for (const probe of state.pcm) {
      if (probe.pc < state.minPC || probe.context.state !== 'running') continue;
      probe.analyser.getFloatTimeDomainData(probe.samples);
      const rms = Math.sqrt(probe.samples.reduce((sum, sample) => sum + sample * sample, 0) / probe.samples.length);
      probe.maxRms = Math.max(probe.maxRms, rms);
      if (rms > 0.0001 && !state.decodedAt) { state.decodedAt = now; phase('decoded_pcm_ready', { pc: probe.pc }); }
    }
    const target = document.querySelector(`[data-keyboard-reorder-id="${state.target}"]`)?.closest('.ch-tree-drag-wrap');
    // A moderator's drop draws the member under the target at once as a pending
    // row (class vu-pending); listAt is the row the server broadcast confirmed.
    if (!state.listAt && target && Array.from(target.querySelectorAll('.ch-tree-voice-user:not(.vu-pending) .ch-tree-vu-name')).some(node => node.textContent === 'Voice Bench Member')) state.listAt = now;
    if (selfRowEnabled && !state.selfListAt && target && Array.from(target.querySelectorAll('.ch-tree-vu-name')).some(node => node.textContent === ownName)) state.selfListAt = now;
    if (recoveryEnabled && state.action === 'recovery') {
      // Only the disconnected member has an action origin, and only the owner
      // observes a re-subscription, so each renderer latches its own side.
      if (state.actionAt && !window.__hichatRoom) state.roomLostAt ||= now;
      else if (state.roomLostAt) state.roomRestoredAt ||= now;
      // The owner keeps its transport, so the new-transport filter above cannot
      // apply; once re-subscribed, any running probe carries the member again.
      if (state.resubscribedAt && !state.remoteHeardAt) for (const probe of state.pcm) {
        if (probe.context.state !== 'running') continue;
        probe.analyser.getFloatTimeDomainData(probe.samples);
        if (Math.sqrt(probe.samples.reduce((sum, sample) => sum + sample * sample, 0) / probe.samples.length) > 0.0001) { state.remoteHeardAt = now; break; }
      }
    }
    const lastStats = [];
    for (const pc of state.pcs) {
      if (pc.connectionState !== 'connected') continue;
      try { const stats = await pc.getStats(); for (const stat of stats.values()) {
        if (stat.type === 'inbound-rtp' || stat.type === 'outbound-rtp' || stat.type === 'media-source') lastStats.push({ pc: state.pcs.indexOf(pc), type: stat.type, kind: stat.kind || stat.mediaType, packetsReceived: stat.packetsReceived, concealedSamples: stat.concealedSamples, bytesReceived: stat.bytesReceived, bytesSent: stat.bytesSent, totalAudioEnergy: stat.totalAudioEnergy, totalSamplesReceived: stat.totalSamplesReceived, audioLevel: stat.audioLevel });
        if (stat.type !== 'inbound-rtp' || (stat.kind || stat.mediaType) !== 'audio') continue;
        if (state.pcs.indexOf(pc) < state.minPC) continue;
        if ((stat.totalSamplesReceived || 0) > 0 && !state.decodedSamplesAt) state.decodedSamplesAt = now;
        const energy = stat.totalAudioEnergy || 0, key = `${state.pcs.indexOf(pc)}:${stat.id}`;
        state.lastEnergy.set(key, energy);
        // Keep RTP energy as supporting evidence; encrypted-transform Chromium
        // builds can report zero here despite nonzero decoded track PCM.
      } } catch {}
    }
    state.lastStats = lastStats;
  }, 40);
}
async function launch(account, fixture, spki, wav) {
  const profile = fs.mkdtempSync(path.join(runDir, `${label}-${account === fixture.owner ? 'owner' : 'member'}-profile-`));
  const app = await _electron.launch({ executablePath: options.exe, timeout: 90_000,
    args: [`--user-data-dir=${profile}`, '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`, '--autoplay-policy=no-user-gesture-required', '--mute-audio', '--disable-background-networking', '--disable-component-update', '--proxy-server=http://127.0.0.1:9444', '--proxy-bypass-list=127.0.0.1;localhost', `--ignore-certificate-errors-spki-list=${spki}`],
    env: { ...process.env, ELECTRON_FORCE_PROD: '1' } });
  apps.push(app);
  const actualProfile = await app.evaluate(({ app }) => app.getPath('userData'));
  if (path.resolve(actualProfile).toLowerCase() !== path.resolve(profile).toLowerCase()) throw Error('Electron profile isolation assertion failed');
  await app.evaluate(({ BrowserWindow, app }) => {
    BrowserWindow.prototype.show = function() { this.hide(); };
    for (const window of BrowserWindow.getAllWindows()) { window.setSkipTaskbar(true); window.hide(); window.webContents.setBackgroundThrottling(false); }
    app.on('browser-window-created', (_event, window) => { window.setSkipTaskbar(true); window.webContents.setBackgroundThrottling(false); });
  });
  await app.context().addInitScript(instrument, { origin: tlsOrigin, ownId: account.id, otherId: account === fixture.owner ? fixture.member.id : fixture.owner.id, channels: fixture.channels, phasesEnabled,
    ownName: account.displayName, selfRowEnabled: selfRow, recoveryEnabled: recoveryMode !== 'none' });
  let page = (await app.firstWindow());
  for (let i = 0; i < 100; i++) { const main = app.windows().find(win => win.url().startsWith('app://')); if (main) { page = main; break; } await new Promise(resolve => setTimeout(resolve, 50)); }
  await page.waitForURL('app://**', { timeout: 30_000 });
  page.__benchResources = [];
  if (phasesEnabled) page.on('requestfinished', request => {
    const resource = new URL(request.url());
    if (resource.protocol !== 'app:' || !/\.(js|wasm)$/.test(resource.pathname)) return;
    const timing = request.timing();
    page.__benchResources.push({ asset: resource.pathname.split('/').pop(), startAt: timing.startTime,
      responseEndAt: timing.startTime + timing.responseEnd, durationMs: timing.responseEnd });
  });
  await page.reload();
  await page.getByLabel(/^Username/i).fill(account.username, { timeout: 60_000 });
  await page.getByLabel(/^Password/i).fill(account.password);
  await page.getByRole('button', { name: /^Log In$/ }).click();
  await page.locator('.server-rail').waitFor({ timeout: 60_000 });
  for (const selector of ['.welcome-btn', '.download-prompt-btn-dismiss']) if (await page.locator(selector).isVisible().catch(() => false)) await page.locator(selector).click();
  await page.locator(`[data-keyboard-reorder-id="${fixture.server.id}"]`).first().click();
  await page.locator(`[data-keyboard-reorder-id="${fixture.channels[0].id}"]`).waitFor({ timeout: 20_000 });
  if (account === fixture.member && preparation !== 'none') {
    report.preparationExperiment.measurements.push(await page.evaluate(async ({ mode, asset }) => {
      const bench = window.__voiceBench, startAt = Date.now(), captureCount = bench.state.captures, pcCount = bench.state.pcs.length;
      const roomBefore = !!window.__hichatRoom;
      bench.mark('preparation', startAt, '');
      let previousTick = performance.now(), maxTimerGapMs = 0, timerTicks = 0;
      const heartbeat = setInterval(() => { const now = performance.now(); maxTimerGapMs = Math.max(maxTimerGapMs, now - previousTick); previousTick = now; timerTicks++; }, 16);
      let callReturnMs = null, capabilitySupported = null, moduleImportMs = null;
      if (mode === 'enumerate') await navigator.mediaDevices.enumerateDevices();
      else if (mode === 'video-capability' || mode === 'video-and-module') {
        const beforeCall = performance.now();
        const pending = VideoEncoder.isConfigSupported({ codec: 'avc1.42001E', width: 640, height: 480, hardwareAcceleration: 'prefer-hardware' });
        callReturnMs = performance.now() - beforeCall;
        capabilitySupported = (await pending).supported;
        if (mode === 'video-and-module') {
          const beginImport = performance.now();
          await import(new URL(`./assets/${asset}`, location.href).href);
          moduleImportMs = performance.now() - beginImport;
        }
      } else { const pc = new RTCPeerConnection({ iceServers: [], iceCandidatePoolSize: 0 }); pc.close(); }
      const completedAt = Date.now();
      await new Promise(resolve => setTimeout(resolve, 60));
      clearInterval(heartbeat);
      return { startAt, completedAt, durationMs: completedAt - startAt, callReturnMs, capabilitySupported,
        moduleAsset: mode === 'video-and-module' ? asset : null, moduleImportMs,
        maxTimerGapMs, timerTicks, captures: bench.state.captures - captureCount,
        peerConnections: bench.state.pcs.length - pcCount, roomBefore, roomAfter: !!window.__hichatRoom,
        phases: bench.state.phases, longTasks: bench.state.longTasks };
    }, { mode: preparation, asset: options['preload-asset'] }));
  }
  console.log(`${label}: isolated ${account === fixture.owner ? 'owner' : 'member'} ready`);
  return page;
}
const channel = (page, target) => page.locator(`[data-keyboard-reorder-id="${target.id}"]`).first();
async function mark(owner, member, action, target) {
  const start = Date.now();
  for (const page of [owner, member]) page.__benchResources = [];
  await Promise.all([owner, member].map(page => page.evaluate(({ action, start, target }) => window.__voiceBench.mark(action, start, target), { action, start, target: target.id })));
}
async function snapshot(page) {
  const value = await page.evaluate(() => window.__voiceBench.result());
  return { ...value, assetRequests: (page.__benchResources || []).filter(resource => resource.startAt >= value.preparedAt) };
}
async function ready(page) { await page.waitForFunction(() => window.__voiceBench.state.decodedAt !== null, null, { timeout: 25_000 }); }
// Supporting milestones must not turn a valid audio sample into a failed run:
// the wait is bounded and an unobserved milestone is reported as null.
const observed = (page, field, timeout) => page.waitForFunction(field => window.__voiceBench.state[field] !== null, field, { timeout }).catch(() => {});
// Without this wait a row slower than the first decoded audio would be
// censored, which is exactly the case the milestone exists to expose.
async function selfRowReady(page) { if (selfRow) await observed(page, 'selfListAt', 10_000); }
async function ownerJoin(owner, destination) {
  const count = await owner.evaluate(() => window.__voiceBench.state.pcs.length);
  await channel(owner, destination).click();
  await owner.waitForFunction(async count => {
    for (const pc of window.__voiceBench.state.pcs.slice(count)) {
      if (pc.connectionState !== 'connected') continue;
      const stats = await pc.getStats();
      if (Array.from(stats.values()).some(stat => stat.type === 'outbound-rtp' && (stat.kind || stat.mediaType) === 'audio' && stat.packetsSent > 0)) return true;
    }
    return false;
  }, count, { timeout: 25_000 });
}
function measured(member, owner, move = false) {
  const start = (move ? owner.actionAt : member.actionAt) || member.preparedAt;
  const shift = start - member.preparedAt;
  const relativeToAction = row => ({ ...row, sinceActionMs: row.sincePreparationMs - shift });
  if (owner.listAt !== null && owner.listAt < start) throw Error('Invalid list timing: participant was already visible before the action');
  return { ...member, timingOrigin: (move ? owner.actionAt : member.actionAt) ? 'actual DOM input event' : 'automation dispatch upper bound',
    resolvedActionAt: start, actionObserver: move ? 'owner DOM drop' : 'member DOM click', listObservedAt: owner.listAt, listObserver: 'owner sidebar',
    token: member.token.map(relativeToAction), ws: member.ws.map(relativeToAction), cues: member.cues.map(relativeToAction), phases: member.phases.map(relativeToAction),
    assetRequests: member.assetRequests.map(row => ({ ...row, sinceActionMs: row.startAt - start })),
    longTasks: member.longTasks.map(row => ({ ...row, sinceActionMs: row.at - start })),
    listMs: owner.listAt === null ? null : owner.listAt - start,
    decodedAudioMs: member.decodedAt === null ? null : member.decodedAt - start,
    decodedSamplesMs: member.decodedSamplesAt === null ? null : member.decodedSamplesAt - start,
    connectionMs: member.connectionAt === null ? null : member.connectionAt - start,
    ...(selfRow ? selfRowTiming(member, start) : {}) };
}
function selfRowTiming(member, start) {
  const stale = member.selfListAt !== null && member.selfListAt < start;
  return { selfListObservedAt: member.selfListAt, selfListObserver: 'member sidebar',
    selfListMs: member.selfListAt === null || stale ? null : member.selfListAt - start,
    ...(stale ? { selfListInvalidated: 'own row was already visible before the action' } : {}) };
}
async function move(owner, member, fixture, destination, deafened = false) {
  await ownerJoin(owner, destination);
  await mark(owner, member, deafened ? 'deafened-move' : 'move', destination);
  await owner.locator('.ch-tree-voice-user').filter({ hasText: fixture.member.displayName }).first().dragTo(channel(owner, destination));
  await owner.waitForFunction(() => window.__voiceBench.state.listAt !== null, null, { timeout: 20_000 });
  if (deafened) {
    // The join has its credentials either from the token response or, when the
    // forced move embedded them, from that event: no token request follows it.
    await member.waitForFunction(() => { const s = window.__voiceBench.state; return s.token.some(x => x.status === 200) || s.ws.some(x => x.op === 'voice_force_move' && x.embeddedCredentials); }, null, { timeout: 20_000 });
    await new Promise(resolve => setTimeout(resolve, 1500));
  } else await ready(member);
  await selfRowReady(member);
  const memberResult = await snapshot(member);
  const ownerResult = await snapshot(owner);
  const forcedAt = memberResult.ws.find(event => event.op === 'voice_force_move')?.sincePreparationMs ?? Infinity;
  return { ...measured(memberResult, ownerResult, true), ...(deafened ? { deafenStillOn: await member.getByRole('button', { name: 'Undeafen', exact: true }).getAttribute('aria-pressed'), audibleCueCount: memberResult.cues.filter(x => x.sincePreparationMs >= forcedAt && /^join[.-]/.test(x.asset || '') && x.contextState === 'running' && x.renderedPeakRms > 0.0001).length } : {}) };
}
async function switchChannel(owner, member, destination) {
  // Same preconditions as move(): the owner already publishes in the
  // destination, so the member's first decoded remote PCM is measurable.
  await ownerJoin(owner, destination);
  await mark(owner, member, 'switch', destination);
  await channel(member, destination).click();
  await owner.waitForFunction(() => window.__voiceBench.state.listAt !== null, null, { timeout: 20_000 });
  await ready(member);
  await selfRowReady(member);
  return { ...measured(await snapshot(member), await snapshot(owner)), kind: 'self-initiated voice channel switch' };
}
async function recover(owner, member, occupied) {
  await mark(owner, member, 'recovery', occupied);
  await owner.evaluate(() => window.__voiceBench.observeResubscription());
  await member.evaluate(scenario => window.__voiceBench.forceDisconnect(scenario), recoveryMode);
  await ready(member);
  await observed(member, 'roomRestoredAt', 1_000);
  await observed(owner, 'remoteHeardAt', 20_000);
  // The member never left the occupied channel, so the sidebar-row latches
  // fire on the first poll after mark and say nothing about the recovery.
  const { listAt, selfListAt, ...telemetry } = await snapshot(member);
  const memberSide = await member.evaluate(() => window.__voiceBench.recovery()), ownerSide = await owner.evaluate(() => window.__voiceBench.recovery());
  const start = telemetry.actionAt, shift = start - telemetry.preparedAt;
  const relativeToAction = row => ({ ...row, sinceActionMs: row.sincePreparationMs - shift });
  const since = at => at === null || at < start ? null : at - start;
  return { ...telemetry, kind: `forced ${recoveryMode} recovery`, timingOrigin: 'renderer call that forces the disconnect',
    resolvedActionAt: start, actionObserver: `member room.simulateScenario('${recoveryMode}')`,
    token: telemetry.token.map(relativeToAction), ws: telemetry.ws.map(relativeToAction), cues: telemetry.cues.map(relativeToAction), phases: telemetry.phases.map(relativeToAction),
    assetRequests: telemetry.assetRequests.map(row => ({ ...row, sinceActionMs: row.startAt - start })),
    longTasks: telemetry.longTasks.map(row => ({ ...row, sinceActionMs: row.at - start })),
    roomLostAt: memberSide.roomLostAt, roomRestoredAt: memberSide.roomRestoredAt, ownerResubscribedAt: ownerSide.resubscribedAt, ownerDecodedAudioAt: ownerSide.remoteHeardAt,
    decodedAudioMs: since(telemetry.decodedAt), decodedSamplesMs: since(telemetry.decodedSamplesAt), connectionMs: since(telemetry.connectionAt),
    roomLostMs: since(memberSide.roomLostAt), roomRestoredMs: since(memberSide.roomRestoredAt),
    ownerResubscribedMs: since(ownerSide.resubscribedAt), ownerDecodedAudioMs: since(ownerSide.remoteHeardAt) };
}
async function positiveCueControl(owner, member, destination) {
  // A real product preview in an unchanged room validates the downstream PCM
  // probe without token/session transitions cancelling an otherwise valid cue.
  await member.locator('.ub-settings').click();
  await member.locator('.settings-nav-item').filter({ hasText: /^Notifications$/ }).click();
  await mark(owner, member, 'positive-cue-control', destination);
  await member.getByRole('button', { name: 'Preview: Join', exact: true }).click();
  await new Promise(resolve => setTimeout(resolve, 1400));
  const { cues } = await member.evaluate(() => window.__voiceBench.result());
  await member.locator('.settings-close').click();
  return { kind: 'actual product Join preview in stable non-deafened room', cues,
    passed: cues.some(cue => /^join[.-]/.test(cue.asset || '') && cue.renderedPeakRms > 0.0001) };
}
async function cancellation(owner, member, data) {
  if (await member.locator('.ub-end').isVisible()) await member.locator('.ub-end').click();
  const start = Date.now(), previous = delayedTokens.length;
  await mark(owner, member, 'join', data.channels[1]);
  await member.evaluate(() => { window.__voiceBench.state.delayNextToken = true; });
  await channel(member, data.channels[1]).click();
  for (let i = 0; i < 200 && delayedTokens.length === previous; i++) await new Promise(resolve => setTimeout(resolve, 25));
  if (delayedTokens.length === previous) throw Error('Cancellation probe did not reach fixture delay');
  await channel(member, data.channels[0]).click();
  await member.waitForFunction(() => window.__voiceBench.state.token.some(row => row.status === 200), null, { timeout: 20_000 });
  await new Promise(resolve => setTimeout(resolve, 5200));
  const telemetry = await member.evaluate(() => window.__voiceBench.result());
  return { durationMs: Date.now() - start, upstream: delayedTokens[previous], token: telemetry.token, selfJoinChannels: telemetry.ws.filter(row => row.op === 'voice_state_update' && row.self && row.action === 'join').map(row => row.channel), latestTargetVisible: await member.locator('.ub-voice-row').innerText().catch(() => null) };
}
function summarize(rows, names = ['listMs', 'decodedAudioMs', 'decodedSamplesMs', 'connectionMs', ...(selfRow ? ['selfListMs'] : [])]) {
  const metrics = {};
  const median = values => values.length === 0 ? null : values.length % 2
    ? values[Math.floor(values.length / 2)]
    : (values[values.length / 2 - 1] + values[values.length / 2]) / 2;
  for (const name of names) { const values = rows.map(row => row[name]).filter(Number.isFinite).sort((a,b) => a-b); metrics[name] = { n: values.length, median: median(values), p95: values[Math.max(0, Math.ceil(values.length * 0.95) - 1)] ?? null }; }
  const token = rows.flatMap(row => row.token).filter(token => token.status === 200).map(token => token.durationMs).sort((a,b) => a-b);
  metrics.tokenMs = { n: token.length, median: median(token), p95: token[Math.max(0, Math.ceil(token.length * 0.95) - 1)] ?? null };
  return metrics;
}
(async () => {
  try {
    const archive = path.join(path.dirname(path.resolve(options.exe)), 'resources', 'app.asar');
    report.applicationArchiveSha256 = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
    const spki = await startProxy(), data = await fixture(), wav = microphoneFile();
    const owner = await launch(data.owner, data, spki, wav);
    let member = await launch(data.member, data, spki, wav);
    report.appVersion = await apps[0].evaluate(({ app }) => app.getVersion());
    report.runtime = await apps[0].evaluate(() => ({ electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node }));
    const alpha = data.channels[0], beta = data.channels[1];
    const memberRow = owner.locator('.ch-tree-voice-user').filter({ hasText: data.member.displayName });
    if (await memberRow.isVisible().catch(() => false)) {
      // A previous process exit can leave a server reconnect-grace presence.
      // Clear only this synthetic member through the real owner's moderation UI.
      await memberRow.click({ button: 'right' });
      await owner.getByRole('button', { name: 'Disconnect from Voice', exact: true }).click();
      await memberRow.waitFor({ state: 'hidden', timeout: 25_000 });
      report.initialStalePresenceCleared = true;
    }
    await ownerJoin(owner, alpha);
    for (let i = 0; i < rounds; i++) {
      await owner.locator('.ch-tree-voice-user').filter({ hasText: data.member.displayName }).waitFor({ state: 'hidden', timeout: 25_000 });
      await mark(owner, member, 'join', alpha);
      await channel(member, alpha).click();
      await ready(member);
      await selfRowReady(member);
      const result = measured(await snapshot(member), await snapshot(owner));
      result.kind = coldOnly || i === 0 ? 'cold application voice join' : 'warm voice rejoin';
      report.joins.push(result); saveReport();
      console.log(`${label}: join ${i + 1}/${rounds}, decoded ${result.decodedAudioMs} ms`);
      if (i < rounds - 1) {
        await member.locator('.ub-end').click();
        await owner.locator('.ch-tree-voice-user').filter({ hasText: data.member.displayName }).waitFor({ state: 'hidden', timeout: 15_000 });
        if (coldOnly) {
          await apps[apps.length - 1].evaluate(({ app }) => app.exit(0)).catch(() => {});
          member = await launch(data.member, data, spki, wav);
        }
      }
    }
    if (coldOnly) {
      report.summary = { coldJoins: summarize(report.joins) };
      await member.locator('.ub-end').click();
      await memberRow.waitFor({ state: 'hidden', timeout: 15_000 });
      await owner.locator('.ub-end').click();
      return;
    }
    let destination = beta;
    for (let i = 0; i < (soundOnly ? 0 : rounds); i++) {
      const result = await move(owner, member, data, destination);
      report.moves.push(result); saveReport();
      console.log(`${label}: move ${i + 1}/${rounds}, decoded ${result.decodedAudioMs} ms`);
      destination = destination.id === alpha.id ? beta : alpha;
    }
    // The additive scenarios run here, where both clients share the channel
    // opposite to destination and the member is neither muted nor deafened,
    // and they leave that state as the sound controls below expect it.
    for (let i = 0; i < (selfSwitch ? rounds : 0); i++) {
      const result = await switchChannel(owner, member, destination);
      report.selfSwitches.push(result); saveReport();
      console.log(`${label}: self-switch ${i + 1}/${rounds}, decoded ${result.decodedAudioMs} ms`);
      destination = destination.id === alpha.id ? beta : alpha;
    }
    for (let i = 0; i < (recoveryMode === 'none' ? 0 : rounds); i++) {
      const result = await recover(owner, member, destination.id === alpha.id ? beta : alpha);
      report.recoveries.push(result); saveReport();
      console.log(`${label}: ${recoveryMode} recovery ${i + 1}/${rounds}, decoded ${result.decodedAudioMs} ms`);
      // The product resets its rejoin backoff only after 30 s of stable voice;
      // a sooner round would measure its later, longer steps and then give up.
      if (recoveryMode === 'server-leave' && i < rounds - 1) await new Promise(resolve => setTimeout(resolve, 31_000));
    }
    report.positiveCueControl = await positiveCueControl(owner, member, destination);
    await member.getByRole('button', { name: 'Mute', exact: true }).click();
    await member.getByRole('button', { name: 'Deafen', exact: true }).click();
    report.deafenedMove = await move(owner, member, data, destination, true);
    if (!soundOnly) report.cancellation = await cancellation(owner, member, data);
    report.summary = { joins: summarize(report.joins), warmJoins: summarize(report.joins.slice(1)), moves: summarize(report.moves),
      ...(selfSwitch ? { selfSwitches: summarize(report.selfSwitches) } : {}),
      ...(recoveryMode === 'none' ? {} : { recoveries: summarize(report.recoveries, recoveryMetrics) }) };
  } catch (error) {
    report.failures.push({ message: error.message.split('\n')[0] });
    for (let index = 0; index < apps.length; index++) {
      const page = apps[index].windows().find(p => p.url().startsWith('app://'));
      if (page) report.failures.push({ client: index, route: new URL(page.url()).pathname, telemetry: await page.evaluate(() => window.__voiceBench?.result()).catch(() => null), ui: (await page.locator('body').innerText().catch(() => '')).slice(0, 1300).replace(/voice_\d+_[a-f0-9]+/g, '[synthetic account]') });
    }
    process.exitCode = 1;
    console.error(`${label}: benchmark failed; sanitized details in report`);
  } finally {
    saveReport();
    for (const app of apps.reverse()) await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    for (const server of servers.reverse()) { server.closeAllConnections(); server.close(); }
    console.log(`Saved ${path.relative(root, reportFile)}`);
  }
})();
