const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const { stripTypeScriptTypes } = require('node:module');

function boundaries(window, extra = {}) {
  // Node's built-in type erasure lets this fixture-only test exercise current
  // source even when the desktop compiler/runtime packages are not installed.
  const source = stripTypeScriptTypes(fs.readFileSync('src/desktop/ui-scenario.ts', 'utf8'));
  const start = source.indexOf('let fixtureStage ='), end = source.indexOf('const input = async', start);
  assert.ok(start >= 0 && end > start);
  const context = { window, createHash, setTimeout, clearTimeout, ...extra };
  vm.runInNewContext(source.slice(start, end) + '\nglobalThis.testBoundary = {evaluate,waitFor,resizeContextViewport,setStage(value){fixtureStage=value}};', context, { filename: 'ui-scenario.js' });
  return context.testBoundary;
}
async function until(predicate) {
  const end = Date.now() + 2000;
  while (!predicate()) { if (Date.now() > end) throw Error('Generated boundary was not reached.'); await new Promise(resolve => setTimeout(resolve, 5)); }
}

test('context setup waits for native content dimensions and two renderer frames before continuing', async () => {
  let native = [892, 510], renderer = [892, 510], settled = false, totalFrames = 0;
  const frames = [], requests = [];
  const window = {
    setSize(width, height) { requests.push([width, height]); native = [width - 16, height - 39]; },
    getBounds() { const [width, height] = requests.at(-1); return { width, height }; },
    getContentSize() { return native; },
    webContents: { async executeJavaScript(expression) {
      return vm.runInNewContext(expression, { innerWidth: renderer[0], innerHeight: renderer[1], Promise, requestAnimationFrame(callback) { totalFrames++; frames.push(callback); } });
    } },
  };
  const fixture = boundaries(window);
  const resizing = fixture.resizeContextViewport(640, 560).then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false); assert.equal(totalFrames, 0);
  renderer = native.slice(); await until(() => frames.length === 1);
  frames.shift()(0); assert.equal(settled, false); assert.equal(totalFrames, 2);
  frames.shift()(0); await resizing;
  assert.equal(settled, true); assert.deepEqual(requests, [[640, 560]]);
});

test('context setup fails when the renderer never reaches native content dimensions', async () => {
  let clock = 0, frames = 0;
  const fixture = boundaries({ setSize() {}, getBounds() { return { width: 640, height: 560 }; }, getContentSize() { return [624, 521]; }, webContents: { async executeJavaScript(expression) {
    if (expression.includes('requestAnimationFrame')) frames++;
    return '';
  } } }, { Date: { now() { clock += 15001; return clock; } } });
  await assert.rejects(fixture.resizeContextViewport(640, 560), /renderer viewport matches native content bounds/);
  assert.equal(frames, 0);
});

test('matching old native and renderer sizes cannot release setup before the requested native resize', async () => {
  let bounds = { width: 892, height: 510 }, native = [876, 471], renderer = native.slice(), contentReads = 0, settled = false;
  const frames = [];
  const fixture = boundaries({
    setSize(width, height) { assert.deepEqual([width, height], [640, 560]); },
    getBounds() { return bounds; },
    getContentSize() { contentReads++; return native; },
    webContents: { async executeJavaScript(expression) {
      return vm.runInNewContext(expression, { innerWidth: renderer[0], innerHeight: renderer[1], Promise, requestAnimationFrame(callback) { frames.push(callback); } });
    } },
  });
  const resizing = fixture.resizeContextViewport(640, 560).then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(contentReads, 0); assert.equal(frames.length, 0); assert.equal(settled, false);
  bounds = { width: 640, height: 560 }; native = [624, 521];
  await until(() => contentReads === 1);
  assert.equal(frames.length, 0); assert.equal(settled, false);
  renderer = native.slice(); await until(() => frames.length === 1);
  frames.shift()(0); assert.equal(settled, false);
  frames.shift()(0); await resizing;
  assert.equal(settled, true);
});

test('a native resize that never applies fails before reading content bounds or opening renderer work', async () => {
  let clock = 0, contentReads = 0, rendererCalls = 0;
  const fixture = boundaries({
    setSize() {}, getBounds() { return { width: 892, height: 510 }; },
    getContentSize() { contentReads++; return [876, 471]; },
    webContents: { async executeJavaScript() { rendererCalls++; } },
  }, { Date: { now() { clock += 15001; return clock; } } });
  fixture.setStage('downloads-context-restored');
  await assert.rejects(fixture.resizeContextViewport(640, 560), /native resize timed out: stage=downloads-context-restored/);
  assert.equal(contentReads, 0); assert.equal(rendererCalls, 0);
});

test('script failures expose only a stage, expression hash and bounded boolean/numeric state', async () => {
  const secret = 'PRIVATE_PROVIDER_SENTINEL /private/profile?token=secret';
  const fixture = boundaries({ webContents: { async executeJavaScript(expression) {
    if (expression.includes('window.__contextSmoke')) return { width: 640, height: 480, menu: false, manage: false, ownerPresent: true, ownerSelected: true, resizes: 2, outsidePointers: 1, resizesSinceOpen: 1, outsideSinceOpen: 0, private: secret, unrelated: secret };
    if (expression === '42') return 42;
    throw Error(secret);
  } } });
  fixture.setStage('files-context-file'); assert.equal(await fixture.evaluate('42'), 42);
  const expression = `throw Error(${JSON.stringify(secret)})`;
  await assert.rejects(fixture.evaluate(expression), error => {
    assert.match(error.message, /stage=files-context-file; callerLine=\d+; expressionHash=[a-f0-9]{12}/);
    assert.match(error.message, /"resizesSinceOpen":1/); assert.match(error.message, /"ownerSelected":true/);
    assert.ok(!error.message.includes(secret)); assert.ok(!error.message.includes(expression)); assert.ok(!error.message.includes('/private/'));
    return true;
  });
});

test('missing context menu diagnostics retain owner and event evidence without renderer messages', async () => {
  let clock = 0;
  const fixture = boundaries({ webContents: { async executeJavaScript(expression) {
    if (expression.includes('window.__contextSmoke')) return { width: 892, height: 472, menu: false, manage: false, ownerPresent: true, ownerSelected: true, resizes: 3, outsidePointers: 0, resizesSinceOpen: 1, outsideSinceOpen: 0 };
    throw Error('PRIVATE_RENDERER_SENTINEL');
  } } }, { Date: { now() { clock += 15001; return clock; } } });
  fixture.setStage('files-context-file');
  await assert.rejects(fixture.waitFor('false', '.context-menu [data-group="Manage"]'), error => {
    assert.match(error.message, /UI smoke context menu timed out: stage=files-context-file/);
    assert.match(error.message, /"menu":false/); assert.match(error.message, /"resizesSinceOpen":1/);
    assert.ok(!error.message.includes('PRIVATE_RENDERER_SENTINEL')); return true;
  });
});

test('Downloads failures inspect the current download owner and fresh open baseline without exposing its identity', async () => {
  const owner = 'generated-private-job-identifier';
  let inspectedDownloads = false;
  const row = { dataset: { jobId: owner }, classList: { contains(value) { return value === 'selected'; } }, querySelector() { return { textContent: 'Waiting' }; } };
  const renderer = {
    innerWidth: 640, innerHeight: 532,
    window: { __contextSmoke: { view: 'downloads', owner, opened: true, resizes: 10, outsidePointers: 0, beforeResizes: 10, beforeOutside: 0 } },
    document: {
      querySelectorAll(selector) { assert.equal(selector, '[data-job-id]'); inspectedDownloads = true; return [row]; },
      querySelector(selector) {
        if (selector === '.context-menu' || selector.includes('data-group="Recovery"')) return {};
        return null;
      },
    },
  };
  const fixture = boundaries({ webContents: { async executeJavaScript(expression) {
    if (expression.includes('window.__contextSmoke')) return vm.runInNewContext(expression, renderer);
    throw Error('Generated menu failure.');
  } } });
  fixture.setStage('downloads-context-restored');
  await assert.rejects(fixture.evaluate('generated failure'), error => {
    assert.equal(inspectedDownloads, true);
    assert.match(error.message, /stage=downloads-context-restored/);
    assert.match(error.message, /"ownerPresent":true/);
    assert.match(error.message, /"ownerSelected":true/);
    assert.match(error.message, /"ownerWaiting":true/);
    assert.match(error.message, /"recovery":true/);
    assert.match(error.message, /"resizesSinceOpen":0/);
    assert.ok(!error.message.includes(owner));
    return true;
  });
});
