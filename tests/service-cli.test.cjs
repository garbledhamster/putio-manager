const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runServiceCommand } = require('../dist/server/service-cli');

const secret = 'SENTINEL_PRIVATE_PATH_TOKEN_https://private.example.test/credential';
function fake(results) {
  const calls = [];
  const runner = async (file, args) => {
    calls.push([file, args]); const result = results.shift();
    if (result instanceof Error) throw result;
    if (!result) throw new Error(secret);
    return result;
  };
  return { calls, runner };
}
async function run(args, runner, metadataReader) {
  let output = '';
  const code = await runServiceCommand(args, line => { output += line; }, runner, metadataReader);
  assert.equal(output.split('\n').length, 2); assert.equal(output.includes(secret), false);
  return { code, result: JSON.parse(output) };
}
function metadata(patch = {}) {
  const fields = Array(20).fill('0');
  fields[0] = 'S'; fields[11] = '200'; fields[12] = '50'; fields[19] = '900';
  return { pid: '42', stat: `42 (${secret} with ) parentheses) ${fields.join(' ')}`,
    io: `rchar: 999999\nread_bytes: 34359738368\nprivate_field: ${secret}\n`, uptime: '20.00 80.00\n', clockTicksPerSecond: 100,
    username: secret, command: secret, path: secret, ...patch };
}

test('service help is discoverable on every platform without configuration or a runner call', async () => {
  for (const command of ['help', '--help']) {
    const f = fake([]); const { code, result } = await run([command], f.runner);
    assert.equal(code, 0); assert.equal(result.value.service, 'putio-manager.service');
    assert.equal(result.value.engineConfigurationRequired, false); assert.match(result.value.restartScope, /does not reboot/);
    assert.deepEqual(f.calls, []);
    assert.equal((await run([command])).code, 0);
  }
});

test('status uses is-active with only the fixed literal unit and controlled JSON', async () => {
  const f = fake([{ stdout: 'active\n', exitCode: 0 }]);
  const { code, result } = await run(['status'], f.runner);
  assert.equal(code, 0); assert.equal(result.value.status, 'active'); assert.equal(result.value.verified, true);
  assert.equal(result.value.running, true); assert.equal(result.value.scope, 'system');
  assert.equal(result.value.process.processState, 'unavailable');
  assert.equal(result.value.rebootsMachine, false); assert.equal(result.value.queueResumption, 'not-verified');
  assert.deepEqual(f.calls, [['systemctl', ['--no-ask-password', 'is-active', 'putio-manager.service']]]);
});

test('inactive and failed states are useful query results even with nonzero is-active exit codes', async () => {
  for (const status of ['inactive', 'failed']) {
    const f = fake([{ stdout: `${status}\n`, exitCode: 3 }]);
    const { code, result } = await run(['status'], f.runner);
    assert.equal(code, 0); assert.equal(result.value.status, status); assert.equal(result.value.verified, true);
    assert.equal(result.value.running, status === 'inactive' ? false : null);
  }
});

test('start, stop, restart verify is-active after requesting exactly one fixed service action', async () => {
  for (const action of ['start', 'stop', 'restart']) {
    const state = action === 'stop' ? 'inactive' : 'active';
    const f = fake([{ stdout: secret, exitCode: 0 }, { stdout: `${state}\n`, exitCode: state === 'active' ? 0 : 3 }]);
    const { code, result } = await run([action], f.runner);
    assert.equal(code, 0); assert.equal(result.value.requested, action); assert.equal(result.value.acknowledged, true);
    assert.equal(result.value.verified, true); assert.equal(result.value.queueResumption, 'not-verified');
    assert.deepEqual(f.calls, [['systemctl', ['--no-ask-password', action, 'putio-manager.service']], ['systemctl', ['--no-ask-password', 'is-active', 'putio-manager.service']]]);
  }
});

test('--user selects only the fixed user service scope without sudo or privilege changes', async () => {
  const f = fake([{ stdout: '', exitCode: 0 }, { stdout: 'active', exitCode: 0 }]);
  const { code, result } = await run(['restart', '--user'], f.runner);
  assert.equal(code, 0); assert.equal(result.value.scope, 'user');
  assert.deepEqual(f.calls, [['systemctl', ['--user', '--no-ask-password', 'restart', 'putio-manager.service']], ['systemctl', ['--user', '--no-ask-password', 'is-active', 'putio-manager.service']]]);
});

test('strict grammar rejects arbitrary units, commands, hosts, elevation and shell arguments before execution', async () => {
  for (const args of [[], ['reboot'], ['restart', 'other.service'], ['restart', '--system'], ['--user', 'restart'],
    ['restart', '--user', secret], ['status', '--host', secret], ['restart;reboot'], ['sudo', 'restart'], ['status', '--json'],
    ['start', '--user;reboot'], ['service', 'status'], ['status', '--user', '--user']]) {
    const f = fake([]); const { code, result } = await run(args, f.runner);
    assert.equal(code, 1); assert.equal(result.error.code, 'invalid-service-arguments'); assert.deepEqual(f.calls, []);
  }
});

test('unknown status, injected diagnostics and malformed runner results never become output labels', async () => {
  for (const result of [{ stdout: secret, exitCode: 1 }, { stdout: `active\n${secret}`, exitCode: 0 },
    { stdout: 'active', exitCode: 3 }, { stdout: secret.repeat(100), exitCode: 0 },
    { stdout: 'active', exitCode: Infinity }, { stdout: 'active', exitCode: -1 }]) {
    const { code, result: output } = await run(['status'], fake([result]).runner);
    assert.equal(code, 1); assert.equal(output.error.code, 'service-state-unverified');
    assert.equal(output.value.status, 'unknown'); assert.equal(output.value.running, null);
  }
});

test('failed service mutation still queries current state without claiming successful restart', async () => {
  const f = fake([{ stdout: secret, exitCode: 1 }, { stdout: 'inactive', exitCode: 3 }]);
  const { code, result } = await run(['restart'], f.runner);
  assert.equal(code, 1); assert.equal(result.error.code, 'service-action-failed');
  assert.equal(result.value.acknowledged, false); assert.equal(result.value.verified, false);
  assert.equal(result.value.status, 'inactive'); assert.equal(f.calls.length, 2);
});

test('accepted mutation with an unexpected final state remains unverified', async () => {
  const f = fake([{ stdout: '', exitCode: 0 }, { stdout: 'activating', exitCode: 3 }]);
  const { code, result } = await run(['restart'], f.runner);
  assert.equal(code, 1); assert.equal(result.error.code, 'service-state-unverified');
  assert.equal(result.value.acknowledged, true); assert.equal(result.value.verified, false); assert.equal(result.value.running, null);
});

test('spawn failures, permissions errors, signals and private stderr remain controlled', async () => {
  for (const args of [['status'], ['restart']]) {
    const f = fake([Object.assign(new Error(secret), { stdout: secret, stderr: secret, code: 'EACCES', path: secret })]);
    const { code, result } = await run(args, f.runner);
    assert.equal(code, 1); assert.equal(result.error.code, 'service-control-unavailable');
    assert.equal(result.value.status, 'unknown'); assert.equal(result.value.verified, false);
  }
});

test('default service control is explicitly unsupported outside Linux', { skip: process.platform === 'linux' }, async () => {
  const { code, result } = await run(['restart']);
  assert.equal(code, 1); assert.equal(result.error.code, 'service-platform-unsupported');
});

test('status normalizes injected kernel process metadata without returning PID, command, path or user', async () => {
  const f = fake([{ stdout: 'active', exitCode: 0 }]); const scopes = [];
  const { code, result } = await run(['status', '--user'], f.runner, async scope => { scopes.push(scope); return metadata(); });
  assert.equal(code, 0); assert.deepEqual(scopes, ['user']);
  assert.deepEqual(result.value.process, { processState: 'running', elapsedSeconds: 11, cpuSeconds: 2.5,
    bytesRead: 34359738368, applicationReady: null, readiness: 'not-verified' });
  assert.equal(f.calls.length, 1, 'injected readers and runners do not collect real OS metadata');
  for (const key of ['pid', 'username', 'command', 'path']) assert.equal(Object.hasOwn(result.value.process, key), false);
});

test('a zero MainPID reports no running process without manufacturing time or I/O counters', async () => {
  const { code, result } = await run(['status'], fake([{ stdout: 'inactive', exitCode: 3 }]).runner, async () => ({ pid: '0' }));
  assert.equal(code, 0); assert.deepEqual(result.value.process, { processState: 'not-running', elapsedSeconds: null,
    cpuSeconds: null, bytesRead: null, applicationReady: null, readiness: 'not-verified' });
});

test('malformed PID, stat, time and I/O counters become unavailable without leaking diagnostics', async () => {
  for (const value of [null, metadata({ pid: secret }), metadata({ pid: '../42' }), metadata({ pid: '01' }), metadata({ pid: '-1' }),
    metadata({ pid: '4194305' }), metadata({ pid: 42 }), metadata({ stat: secret }), metadata({ stat: metadata().stat.replace(/^42 /, '43 ') }),
    metadata({ stat: metadata().stat.replace('S 0', 'SECRET 0') }), metadata({ io: `read_bytes: 9007199254740992\n${secret}` }),
    metadata({ io: `read_bytes: -1\n${secret}` }), metadata({ uptime: secret }), metadata({ uptime: '1.00 3.00' }),
    metadata({ clockTicksPerSecond: 0 }), metadata({ clockTicksPerSecond: Infinity }), metadata({ clockTicksPerSecond: 1.5 })]) {
    const { code, result } = await run(['status'], fake([{ stdout: 'active', exitCode: 0 }]).runner, async () => value);
    assert.equal(code, 0); assert.deepEqual(result.value.process, { processState: 'unavailable', elapsedSeconds: null,
      cpuSeconds: null, bytesRead: null, applicationReady: null, readiness: 'not-verified' });
  }
});

test('process metadata permissions and read failures do not hide the known service state or expose raw errors', async () => {
  const { code, result } = await run(['status'], fake([{ stdout: 'active', exitCode: 0 }]).runner,
    async () => { throw Object.assign(new Error(secret), { code: 'EACCES', path: secret }); });
  assert.equal(code, 0); assert.equal(result.value.status, 'active'); assert.equal(result.value.verified, true);
  assert.equal(result.value.process.processState, 'unavailable'); assert.equal(result.value.process.applicationReady, null);
});

test('help and lifecycle mutations never collect process metadata', async () => {
  for (const action of ['help', '--help', 'start', 'stop', 'restart']) {
    let reads = 0;
    const state = action === 'stop' ? 'inactive' : 'active';
    const f = fake([{ stdout: '', exitCode: 0 }, { stdout: state, exitCode: state === 'active' ? 0 : 3 }]);
    const { code, result } = await run([action], f.runner, async () => { reads++; throw new Error(secret); });
    assert.equal(code, 0); assert.equal(reads, 0); assert.equal(Object.hasOwn(result.value, 'process'), false);
  }
});
