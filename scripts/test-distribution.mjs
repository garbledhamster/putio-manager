import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const distribution = path.resolve('release', `PutioManager-${process.platform}-${process.arch}-distribution`);
if (process.argv.includes('--gui')) {
  const relative = process.platform === 'win32' ? 'desktop/PutioManager.exe'
    : process.platform === 'darwin' ? 'desktop/PutioManager.app/Contents/MacOS/PutioManager' : 'desktop/PutioManager';
  const result = spawnSync(path.join(distribution, relative), ['--smoke-test'], { stdio: 'inherit', timeout: 90000 });
  if (result.error || result.status !== 0) throw new Error('Distributed desktop fixture smoke failed.');
  console.log('Distributed native desktop fixture smoke passed.');
  process.exit(0);
}
const runtime = path.join(distribution, process.platform === 'win32' ? 'node.exe' : 'node');
const cli = path.join(distribution, 'headless', 'server', 'cli.js');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'putio-distribution-fixture-'));
const configFile = path.join(temporary, 'private', 'config.json');
let server;
try {
  const root = path.join(temporary, 'downloads');
  await mkdir(root);
  const portProbe = createServer();
  portProbe.listen(0, '127.0.0.1');
  await once(portProbe, 'listening');
  const port = portProbe.address().port;
  await new Promise((resolve, reject) => portProbe.close(error => error ? reject(error) : resolve()));
  // Exercise the shipped setup implementation using only a new synthetic directory.
  const { createSetup } = createRequire(import.meta.url)(path.join(distribution, 'headless', 'server', 'setup.js'));
  createSetup(configFile, root, port);
  server = spawn(runtime, [cli, 'serve', '--config', configFile], { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('Bundled headless server did not become ready.')), 20000);
    const ready = data => {
      if (data.toString().includes('Server ready.')) { clearTimeout(deadline); resolve(); }
    };
    server.stdout.on('data', ready);
    server.once('error', () => { clearTimeout(deadline); reject(new Error('Bundled runtime failed to start.')); });
    server.once('exit', () => { clearTimeout(deadline); reject(new Error('Bundled headless server exited before readiness.')); });
  });
  const command = (name, launcher = false) => JSON.parse(execFileSync(runtime,
    launcher ? [path.join(distribution, 'launch.cjs'), '--mode', 'headless', name, '--config', configFile]
      : [cli, name, '--config', configFile], { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] }));
  const initial = command('status', true);
  assert.equal(initial.ok, true);
  assert.equal(initial.value.engine.protocolVersion, 2);
  assert.equal(initial.value.hasToken, false);
  assert.equal(initial.value.jobs.length, 0);
  command('pause');
  assert.equal(command('status').value.paused, true);
  command('resume');
  assert.equal(command('status').value.paused, false);
  console.log('Bundled Node, setup, launcher, protocol 2, status and pause/resume passed with synthetic state.');
} finally {
  if (server?.pid && server.exitCode === null && server.signalCode === null) {
    const stopped = once(server, 'exit');
    server.kill('SIGTERM');
    await stopped;
  }
  const resolved = path.resolve(temporary);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('putio-distribution-fixture-')) throw new Error('Unexpected fixture cleanup location.');
  await rm(resolved, { recursive: true, force: true });
}
