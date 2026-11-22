const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runAgentCommand, agentJobRef, agentRootRef, safeAnalytics, safeSnapshot, normalizeSettingsPatch } = require('../dist/server/agent-cli');

const secret = 'SENTINEL_private_movie_TOKEN_abc123';
const privatePath = `/private/${secret}/movie.mkv`;
const privateUrl = `https://${secret}.example.test/${secret}?token=${secret}`;
function snapshot() {
  return {
    engine: { id: secret, label: privateUrl, epoch: secret, protocolVersion: 2, revision: 7 },
    connection: { status: 'connected', message: privateUrl }, paused: false,
    roots: [{ id: `root-${secret}`, label: privatePath }],
    settings: { downloadDirectory: privatePath, stagingDirectory: privatePath, stageDownloads: true,
      stagingMaxBytes: 20000, stagingMinimumFreeBytes: 100, parallelDownloads: 2,
      speedLimitBytesPerSecond: 1000, deleteAfterDownload: false, deleteSourceFolders: false,
      autoDownloadInterval: 60, showToolTips: true, autoStartApplication: false, token: secret },
    jobs: [{ id: 'opaque-42', fileId: secret, name: secret, destination: privatePath, status: 'failed',
      bytesReceived: 20, totalBytes: 100, totalKnown: true, speed: 5, deliveryPhase: 'downloading',
      deliveryBytesCopied: 0, verification: 'unverified', cleanupStatus: 'not-required',
      error: privateUrl, stagingWarning: privatePath, cleanupWarning: secret,
      retryAt: '2030-01-02T03:04:05Z', addedAt: '2030-01-02T03:04:05Z', completedAt: secret }],
    rules: [{ id: secret, name: secret, downloadDirectory: privatePath }],
    hasToken: true, secureStorageAvailable: true, scanStatus: secret, stagingNotice: privatePath,
    timeZone: secret, nextRuleRuns: { [secret]: secret }, account: { message: privateUrl }, target: { label: secret },
  };
}
function mock(state = snapshot()) {
  const calls = [];
  return {
    calls, state, reads: 0,
    async getSnapshot() { this.reads++; return this.state; },
    async execute(...args) {
      calls.push(args);
      if (args[0] === 'pause') this.state.paused = true;
      if (args[0] === 'resume') this.state.paused = false;
      if (args[0] === 'saveSettings') Object.assign(this.state.settings, args[1][0]);
      if (args[0] === 'storageStatus') return { volumes: [
        { id: secret, kind: 'download', capacityBytes: 1000, freeBytes: 200, availableBytes: 100, status: 'ok', path: privatePath, label: secret },
        { id: privatePath, kind: 'staging', capacityBytes: null, freeBytes: null, availableBytes: null, status: 'unavailable', error: privateUrl },
      ] };
      return { token: secret, url: privateUrl, path: privatePath, snapshot: this.state };
    },
    subscribe() { throw new Error('No subscription needed'); },
    async close() { throw new Error('Dispatcher must not close shared client'); },
  };
}
async function run(client, args = [], input) {
  let output = '';
  const code = await runAgentCommand(client, args, line => { output += line; }, input);
  assert.equal(output.split('\n').length, 2, 'exactly one JSON line');
  for (const forbidden of [secret, privatePath, privateUrl, 'opaque-42', '2030-01-02T03:04:05Z']) assert.equal(output.includes(forbidden), false);
  return { code, output, result: JSON.parse(output) };
}

test('all safe read commands whitelist fields and never browse media or return metadata labels', async () => {
  for (const command of [[], ['help'], ['status'], ['downloads'], ['analytics'], ['settings'], ['roots'], ['storage']]) {
    const client = mock();
    const { code, result } = await run(client, command);
    assert.equal(code, 0); assert.equal(result.ok, true);
    assert.deepEqual(client.calls.map(call => call[0]), command[0] === 'storage' ? ['storageStatus'] : []);
  }
});

test('status and analytics expose counts, byte totals, fixed buckets, and no timestamps or identity', async () => {
  const client = mock(); const { result } = await run(client, ['status', '--json']);
  assert.equal(result.value.accountConnected, true);
  assert.deepEqual(result.value.counts, { jobs: 1, rules: 1, roots: 1 });
  assert.equal(result.value.analytics.byStatus.failed, 1);
  assert.equal(result.value.analytics.bytesReceived, 20);
  assert.equal(result.value.analytics.totalBytes, 100);
  assert.equal(result.value.analytics.retryEligible, 1);
  assert.equal(result.value.analytics.byErrorCategory.unknown, 1);
  assert.deepEqual(safeAnalytics(client.state), result.value.analytics);
});

test('storage aliases volume IDs and preserves unavailable capacity as unknown', async () => {
  const { result } = await run(mock(), ['storage']);
  assert.match(result.value.volumes[0].ref, /^volume_[0-9a-f]{24}$/);
  assert.equal(result.value.volumes[0].capacityBytes, 1000);
  assert.equal(result.value.volumes[1].capacityBytes, null);
  assert.equal(result.value.volumes[1].freeBytes, null);
  assert.equal(result.value.volumes[1].availableBytes, null);
  assert.equal(result.value.volumes[1].status, 'unavailable');
});

test('job references derive only from opaque IDs and tolerate hostile status values safely', async () => {
  const a = snapshot(), b = snapshot();
  b.jobs[0] = { ...b.jobs[0], name: 'different', destination: '/different', error: 'different' };
  const one = (await run(mock(a), ['downloads'])).result.value.jobs[0];
  const two = (await run(mock(b), ['downloads'])).result.value.jobs[0];
  assert.deepEqual(one, two);
  assert.equal(one.ref, agentJobRef('opaque-42'));
  a.jobs[0].status = secret; a.jobs[0].deliveryPhase = secret; a.jobs[0].cleanupStatus = secret;
  a.jobs[0].verification = secret; a.connection.status = secret;
  const unknown = (await run(mock(a), ['downloads'])).result.value.jobs[0];
  assert.equal(unknown.status, 'unknown'); assert.equal(unknown.retryEligible, false);
  assert.equal(unknown.phase, 'unknown'); assert.equal(unknown.cleanupStatus, 'unknown');
  assert.equal(safeSnapshot(a).accountStatus, 'unknown');
});

test('non-finite, negative, fractional and oversized counters never escape JSON', async () => {
  const state = snapshot();
  for (const field of ['bytesReceived', 'totalBytes', 'speed', 'deliveryBytesCopied', 'attemptCount']) state.jobs[0][field] = Infinity;
  state.jobs.push({ ...state.jobs[0], id: 'other', bytesReceived: -1, totalBytes: Number.MAX_VALUE, speed: NaN, attemptCount: 1.5 });
  const { result } = await run(mock(state), ['analytics']);
  for (const field of ['bytesReceived', 'totalBytes', 'bytesCopied', 'bytesPerSecond']) assert.equal(result.value[field], 0);
  state.jobs[0].bytesReceived = Number.MAX_SAFE_INTEGER; state.jobs[1].bytesReceived = Number.MAX_SAFE_INTEGER;
  assert.equal(safeAnalytics(state).bytesReceived, Number.MAX_SAFE_INTEGER);
});

test('history with stale speeds and verification cannot appear active or inflate verified deliveries', async () => {
  const state = snapshot(), base = state.jobs[0];
  const statuses = [...Array(132).fill('completed'), ...Array(65).fill('needs-attention'), 'canceled'];
  state.jobs = statuses.map((status, index) => ({ ...base, id: `history-${index}`, status,
    speed: 725857.6096204548, verification: 'verified', error: status === 'needs-attention' ? privatePath : undefined }));
  const analytics = (await run(mock(state), ['analytics'])).result.value;
  assert.equal(analytics.active, 0); assert.equal(analytics.bytesPerSecond, 0);
  assert.equal(analytics.byStatus.completed, 132); assert.equal(analytics.byStatus['needs-attention'], 65);
  assert.equal(analytics.verified, 132); assert.ok(analytics.verified <= analytics.byStatus.completed);
  const output = (await run(mock(state), ['downloads'])).result.value.jobs;
  assert.ok(output.every(job => job.bytesPerSecond === 0 && job.active === false));
  assert.ok(output.filter(job => job.status !== 'completed').every(job => job.recordedVerification === 'verified' && job.verification === 'unknown' && job.deliveryVerified === false));
});

test('only current transfer phases contribute speed and only error-free completed deliveries are verified', async () => {
  const state = snapshot(), base = state.jobs[0];
  const statuses = ['downloading', 'copying', 'recovering', 'restarting', 'finalizing', 'cleaning', 'queued', 'waiting', 'paused', 'interrupted', 'failed', 'needs-attention', 'completed', 'unverified', 'canceled'];
  state.jobs = statuses.map((status, index) => ({ ...base, id: `phase-${index}`, status, speed: 10.5, verification: 'verified', error: undefined }));
  const output = (await run(mock(state), ['downloads'])).result.value.jobs;
  assert.deepEqual(output.filter(job => job.bytesPerSecond > 0).map(job => job.status), ['downloading', 'copying', 'recovering', 'restarting']);
  assert.deepEqual(output.filter(job => job.active).map(job => job.status), ['downloading', 'copying', 'recovering', 'restarting', 'finalizing', 'cleaning']);
  assert.deepEqual(output.filter(job => job.deliveryVerified).map(job => job.status), ['completed']);
  const analytics = safeAnalytics(state);
  assert.equal(analytics.bytesPerSecond, 42); assert.equal(analytics.active, 6); assert.equal(analytics.verified, 1);
  state.jobs.push({ ...base, id: 'complete-with-error', status: 'completed', speed: 999.5, verification: 'verified', error: privateUrl });
  assert.equal(safeAnalytics(state).verified, 1); assert.equal(safeAnalytics(state).bytesPerSecond, 42);
  const errored = (await run(mock(state), ['downloads'])).result.value.jobs.at(-1);
  assert.equal(errored.deliveryVerified, false); assert.equal(errored.verification, 'unknown'); assert.equal(errored.recordedVerification, 'verified');
});

test('retry resolves exact anonymous reference and uses a fresh UUID receipt without exposing raw results', async () => {
  const client = mock(); const ref = agentJobRef(client.state.jobs[0].id);
  const { code, result } = await run(client, ['retry', ref]);
  assert.equal(code, 0); assert.equal(result.value.accepted, true);
  assert.equal(client.calls[0][0], 'retryDownload');
  assert.deepEqual(client.calls[0][1], ['opaque-42']);
  assert.match(client.calls[0][2], /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const first = client.calls[0][2]; await run(client, ['retry', ref]); assert.notEqual(client.calls[1][2], first);
});

test('cancel is limited to one resolved job; absent, ambiguous, and ineligible retries execute nothing', async () => {
  const client = mock(), ref = agentJobRef('opaque-42');
  await run(client, ['cancel', ref]); assert.deepEqual(client.calls, [['cancelDownloads', [['opaque-42']]]]);
  for (const mode of ['missing', 'ambiguous', 'completed']) {
    const c = mock();
    if (mode === 'missing') c.state.jobs = [];
    if (mode === 'ambiguous') c.state.jobs.push({ ...c.state.jobs[0] });
    if (mode === 'completed') { c.state.jobs[0].status = 'completed'; c.state.jobs[0].stagingWarning = undefined; }
    assert.equal((await run(c, ['retry', ref])).code, 1); assert.deepEqual(c.calls, []);
  }
});

test('published jobs with a staging cleanup warning can request the guarded engine retry path', async () => {
  for (const status of ['completed', 'unverified']) {
    const client = mock(); client.state.jobs[0].status = status;
    client.state.jobs[0].error = undefined;
    client.state.jobs[0].stagingWarning = 'The verified output is safe, but its staged copy could not be removed.';
    const job = (await run(client, ['downloads'])).result.value.jobs[0];
    assert.equal(job.errorCategory, 'temporary-cleanup'); assert.equal(job.retryEligible, true);
    assert.equal(typeof job.nextAction, 'string');
    assert.equal((await run(client, ['retry', job.ref])).code, 0);
    assert.equal(client.calls[0][0], 'retryDownload');
  }
});

test('cleanup is an explicit guarded retry of a published job, never a cancellation or arbitrary deletion', async () => {
  for (const status of ['completed', 'unverified']) {
    const client = mock(); client.state.jobs[0].status = status;
    const ref = agentJobRef('opaque-42');
    const { result } = await run(client, ['cleanup', ref]);
    assert.equal(result.value.accepted, true); assert.equal(result.value.job.cleanupEligible, true);
    assert.equal(client.calls.length, 1); assert.equal(client.calls[0][0], 'retryDownload');
    assert.deepEqual(client.calls[0][1], ['opaque-42']); assert.match(client.calls[0][2], /^[0-9a-f-]{36}$/);
  }
  for (const status of ['failed', 'downloading', 'completed']) {
    const client = mock(); client.state.jobs[0].status = status;
    if (status === 'completed') client.state.jobs[0].stagingWarning = undefined;
    assert.equal((await run(client, ['cleanup', agentJobRef('opaque-42')])).code, 1);
    assert.deepEqual(client.calls, []);
  }
});

test('selected host output uses only controlled labels and check-rules dispatches explicitly', async () => {
  const client = mock();
  for (const [mode, expected] of [['local', 'this-computer'], ['remote', 'download-server'], [secret, 'engine-host']]) {
    client.state.target = { mode, label: privateUrl, status: 'connected' };
    assert.equal((await run(client, ['status'])).result.value.selectedHost, expected);
  }
  await run(client, ['check-rules']); assert.deepEqual(client.calls, [['checkRules']]);
  const before = client.reads; assert.equal((await run(client, ['check-rules', secret])).code, 1); assert.equal(client.reads, before);
});

test('strict argument validation rejects raw commands, arbitrary IDs, extra flags, and secrets before engine access', async () => {
  for (const args of [['shell', secret], ['listFiles', '0'], ['retry', 'opaque-42'], ['cancel'], ['cancel', '--all'],
    ['status', '--raw'], ['status', '--json', '--json'], ['pause', secret], ['settings-set', JSON.stringify({ token: secret })], ['--json']]) {
    const client = mock(); const { code } = await run(client, args);
    assert.equal(code, 1); assert.equal(client.reads, 0); assert.deepEqual(client.calls, []);
  }
});

test('settings mutations accept only safe typed fields through parsed stdin and preserve engine validation', async () => {
  const client = mock(); const patch = { parallelDownloads: 3, stageDownloads: false, deleteAfterDownload: false, speedLimitBytesPerSecond: 0 };
  assert.equal((await run(client, ['settings-set', '--json'], patch)).code, 0);
  assert.deepEqual(client.calls, [['saveSettings', [patch]]]);
  for (const bad of [{ token: secret }, { downloadDirectory: privatePath }, { stagingDirectory: privatePath }, { parallelDownloads: 21 },
    { parallelDownloads: '2' }, { stageDownloads: 'true' }, { speedLimitBytesPerSecond: -1 }, { stagingMaxBytes: 0 },
    { stagingMinimumFreeBytes: Infinity }, { autoDownloadInterval: 9 }, {}, [], null, JSON.parse('{"__proto__":{"token":"secret"}}')]) {
    const c = mock(); assert.equal(normalizeSettingsPatch(bad), undefined);
    assert.equal((await run(c, ['settings-set', '--json'], bad)).code, 1); assert.equal(c.reads, 0); assert.deepEqual(c.calls, []);
  }
});

test('pause, resume, and root selection use explicit allowlisted engine commands', async () => {
  const client = mock();
  assert.equal((await run(client, ['pause'])).result.value.paused, true);
  assert.equal((await run(client, ['resume'])).result.value.paused, false);
  const ref = agentRootRef(client.state.roots[0].id);
  assert.equal((await run(client, ['root-select', ref])).code, 0);
  assert.deepEqual(client.calls, [['pause'], ['resume'], ['selectDownloadRoot', [`root-${secret}`]]]);
});

test('failures never expose exception messages, stacks, object properties, or secrets', async () => {
  for (const command of [['status'], ['storage'], ['retry', agentJobRef('opaque-42')], ['settings-set', '--json']]) {
    const client = mock();
    if (command[0] === 'status') client.getSnapshot = async () => { throw Object.assign(new Error(privateUrl), { code: secret, path: privatePath }); };
    else client.execute = async () => { throw Object.assign(new Error(privateUrl), { code: secret, path: privatePath }); };
    const { code, result } = await run(client, command, command[0] === 'settings-set' ? { stageDownloads: false } : undefined);
    assert.equal(code, 1); assert.equal(result.ok, false);
    assert.equal(typeof result.error.code, 'string'); assert.equal(typeof result.error.nextAction, 'string');
  }
});

test('known operational failures retain a controlled reason and CLI action while removing private diagnostics', async () => {
  const client = mock();
  client.state.jobs[0].error = `No space left on device ${privatePath} ${privateUrl}`;
  const job = (await run(client, ['downloads'])).result.value.jobs[0];
  assert.equal(job.errorCategory, 'storage-full'); assert.match(job.nextAction, /Run storage and settings/);
  client.execute = async () => { throw Object.assign(new Error(`Disk full ${privateUrl}`), { code: 'ENOSPC', path: privatePath }); };
  const { code, result } = await run(client, ['retry', agentJobRef('opaque-42')]);
  assert.equal(code, 1); assert.equal(result.error.code, 'storage-full'); assert.match(result.error.nextAction, /Run storage and settings/);
});

test('server connection guidance uses CLI service observation and conditional startup checks', async () => {
  const client = mock(); client.getSnapshot = async () => { throw new Error(`Selected engine is unavailable. ${privateUrl}`); };
  const { code, result } = await run(client, ['status']);
  assert.equal(code, 1); assert.equal(result.error.code, 'server-network');
  assert.match(result.error.nextAction, /Run service status on the server/);
  assert.match(result.error.nextAction, /After a restart/); assert.match(result.error.nextAction, /saved-download checks/);
  assert.match(result.error.nextAction, /then run status/); assert.equal(result.error.nextAction.includes('Settings'), false);
});
