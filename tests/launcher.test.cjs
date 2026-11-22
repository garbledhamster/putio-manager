const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Evaluate the actual generated launcher with a fake process and spawn function.
// No desktop executable, child process, account, or application window is opened.
function launchFixture(platform, args) {
  const source = fs.readFileSync(path.join(__dirname, '../scripts/package-distribution.mts'), 'utf8');
  const match = source.match(/await writeFile\(path\.join\(out,'launch\.cjs'\),(`[^`]+`)\);/);
  assert.ok(match, 'Distribution packaging must emit an identifiable launcher');
  const launcher = vm.runInNewContext(match[1]);
  assert.equal(typeof launcher, 'string');
  const platformPath = platform === 'win32' ? path.win32 : path.posix;
  const directory = platform === 'win32' ? 'C:\\fixture-distribution' : '/fixture-distribution';
  const runtime = platformPath.join(directory, platform === 'win32' ? 'node.exe' : 'node');
  const calls = [], errors = [], exits = [];
  const stopped = new Error('Fixture process exited');
  const processFixture = {
    platform,
    env: { DISPLAY: ':fixture' },
    execPath: runtime,
    argv: [runtime, platformPath.join(directory, 'launch.cjs'), ...args],
    exit(code) { exits.push(code); throw stopped; },
  };
  const child = { on() { return this; } };
  try {
    vm.runInNewContext(launcher, {
      __dirname: directory,
      process: processFixture,
      console: { error(message) { errors.push(message); } },
      require(name) {
        if (name === 'node:path') return platformPath;
        assert.equal(name, 'node:child_process');
        return { spawn(command, input, options) {
          calls.push({ command, args: Array.from(input), stdio: options.stdio });
          return child;
        } };
      },
    });
  } catch (error) { if (error !== stopped) throw error; }
  return { calls, errors, exits, directory, platformPath };
}

for (const [platform, executable] of [
  ['win32', 'desktop/PutioManager.exe'],
  ['darwin', 'desktop/PutioManager.app/Contents/MacOS/PutioManager'],
  ['linux', 'desktop/PutioManager'],
]) {
  test(`${platform} agent launcher preserves exact commands and always passes --agent`, () => {
    for (const args of [[], ['status'], ['retry', 'job_0123456789abcdef01234567'], ['settings-set', '--json']]) {
      const result = launchFixture(platform, ['--mode', 'agent', ...args]);
      assert.deepEqual(result.exits, []);
      assert.deepEqual(result.errors, []);
      assert.deepEqual(result.calls, [{
        command: result.platformPath.join(result.directory, executable),
        args: ['--agent', ...args],
        stdio: 'inherit',
      }]);
    }
  });

  test(`${platform} launcher rejects a missing mode before spawning any application`, () => {
    for (const args of [['--mode'], ['--mode', '']]) {
      const result = launchFixture(platform, args);
      assert.deepEqual(result.exits, [1]);
      assert.deepEqual(result.calls, []);
      assert.equal(result.errors.length, 1);
      assert.match(result.errors[0], /mode/i);
    }
  });

  test(`${platform} launcher rejects invalid modes before spawning any application`, () => {
    for (const mode of ['unsupported', '--agent', 'GUI', 'agent-private-sentinel']) {
      const result = launchFixture(platform, ['--mode', mode, 'status']);
      assert.deepEqual(result.exits, [1]);
      assert.deepEqual(result.calls, []);
      assert.equal(result.errors.length, 1);
      assert.match(result.errors[0], /--mode/);
      assert.equal(result.errors[0].includes(mode), false, 'Do not echo an unrecognized argument');
    }
  });
}
