const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const generatedStatus = (patch = {}) => ({ schema: 1, source: 'github', platform: 'windows', currentVersion: '2.2.0', capability: 'automatic', phase: 'available', availableVersion: '2.2.1', message: 'PRIVATE_DIAGNOSTIC /fixture/token=secret', nextAction: 'PRIVATE_DIAGNOSTIC', restartRequired: false, ...patch });
function element(tag, text = '') {
  return { tag, textContent: text, children: [], dataset: {}, attrs: {}, disabled: false,
    append(...items) { this.children.push(...items); }, setAttribute(key, value) { this.attrs[key] = value; }, addEventListener(type, fn) { this[type] = fn; } };
}
function all(root) { return [root, ...root.children.flatMap(all)]; }
function find(root, id) { return all(root).find(item => item.id === id); }
function fixture(api = {}) {
  const renderer = fs.readFileSync('dist/ui/renderer.js', 'utf8');
  const start = renderer.indexOf('function safeDesktopUpdateStatus('), end = renderer.indexOf('async function saveSettings()', start);
  assert.ok(start >= 0 && end > start);
  const context = { desktopUpdate: undefined, desktopUpdatePending: false, current: 'settings', settingsTab: 'updates', search: undefined,
    state: { settings: { downloadDirectory: '/generated/only' }, rules: [{ id: 'generated-rule' }], target: { mode: 'remote', status: 'error' } },
    node: element, title() {}, view: element('main'), api, desktopIntegration: undefined, render() { context.renders++; }, renders: 0,
    button(label, id, click, className = 'secondary') { const result = element('button', label); Object.assign(result, { id, click, className }); return result; } };
  vm.runInNewContext(renderer.slice(start, end) + '\nglobalThis.testUI = {safeDesktopUpdateStatus,receiveDesktopUpdate,requestDesktopUpdate,renderDesktopUpdates,renderSettings};', context);
  return { context, ...context.testUI, draw(status = context.desktopUpdate) { context.desktopUpdate = status; const content = element('div'); context.testUI.renderDesktopUpdates(content); return content; } };
}

test('update display validates every event field and rejects raw helper diagnostics', () => {
  const ui = fixture();
  const safe = ui.safeDesktopUpdateStatus(generatedStatus({phase:'failed',errorCode:'signature-invalid',path:'/PRIVATE_PATH',account:'PRIVATE_ACCOUNT'}));
  assert.match(safe.message, /signature could not be verified/);
  assert.match(safe.nextAction, /Do not install this download/);
  assert.ok(!/PRIVATE_|token=/.test(JSON.stringify(safe)));
  for (const patch of [{schema:2},{source:'other'},{platform:'PRIVATE_PLATFORM'},{phase:'PRIVATE_PHASE'},{phase:['available']},{capability:'PRIVATE_CAPABILITY'},{currentVersion:'2.2.0 /PRIVATE_PATH'}]) assert.equal(ui.safeDesktopUpdateStatus(generatedStatus(patch)), undefined);
  const invalid = ui.safeDesktopUpdateStatus(generatedStatus({availableVersion:'<img src=private>',errorCode:'PRIVATE_ERROR',phase:'failed',progressPercent:Infinity}));
  assert.equal(invalid.availableVersion, undefined); assert.equal(invalid.errorCode, undefined); assert.equal(invalid.progressPercent, undefined);
  assert.ok(!JSON.stringify(invalid).includes('PRIVATE_'));
});

test('Updates remains usable while Remote is offline without settings saves or profile changes', () => {
  const ui = fixture(); ui.context.desktopUpdate = ui.safeDesktopUpdateStatus(generatedStatus());
  const before = JSON.stringify(ui.context.state); ui.renderSettings();
  const panel = ui.context.view;
  assert.ok(find(panel, 'settings-tab-updates')); assert.ok(find(panel, 'updates-check')); assert.ok(find(panel, 'updates-install'));
  assert.equal(find(panel, 'settings-save'), undefined);
  assert.match(find(panel, 'updates-installed').textContent, /2.2.0/);
  assert.match(find(panel, 'updates-available').textContent, /2.2.1/);
  assert.equal(find(panel, 'updates-install').textContent, 'Update and restart');
  assert.equal(find(panel, 'updates-status').attrs['aria-live'], 'polite');
  assert.equal(find(panel, 'updates-status').attrs.role, 'status');
  assert.equal(JSON.stringify(ui.context.state), before);
  assert.ok(!all(panel).some(item => /PRIVATE_|\/generated/.test(item.textContent)));
});

test('progress is finite and bounded, cancellation ends before preparing, and unsupported copies cannot install', () => {
  const ui = fixture();
  for (const [input, expected] of [[-10,0],[125,100],[42,42],[NaN,undefined],[Infinity,undefined]]) {
    const panel = ui.draw(ui.safeDesktopUpdateStatus(generatedStatus({phase:'downloading',progressPercent:input})));
    assert.equal(find(panel, 'updates-progress')?.value, expected); assert.ok(find(panel, 'updates-cancel')); assert.equal(find(panel, 'updates-check').disabled, true);
  }
  for (const phase of ['verifying','ready']) assert.ok(find(ui.draw(ui.safeDesktopUpdateStatus(generatedStatus({phase}))), 'updates-cancel'));
  for (const phase of ['preparing','installing']) {
    const panel = ui.draw(ui.safeDesktopUpdateStatus(generatedStatus({phase})));
    assert.equal(find(panel, 'updates-cancel'), undefined); assert.equal(find(panel, 'updates-install'), undefined); assert.equal(find(panel, 'updates-check').disabled, true);
  }
  assert.equal(find(ui.draw(ui.safeDesktopUpdateStatus(generatedStatus({capability:'unavailable'}))), 'updates-install'), undefined);
});

test('Check, install, and cancel dispatch only parameterless update commands', async () => {
  const calls = []; const ui = fixture(Object.fromEntries(['getDesktopUpdateStatus','checkDesktopUpdate','installDesktopUpdate','cancelDesktopUpdate'].map(name => [name, async (...args) => { calls.push([name, args]); return generatedStatus(); }])));
  await ui.requestDesktopUpdate('status');
  await find(ui.draw(), 'updates-check').click();
  // Click handlers deliberately return void; settle the updater request.
  await new Promise(resolve => setImmediate(resolve));
  find(ui.draw(), 'updates-install').click(); await new Promise(resolve => setImmediate(resolve));
  ui.receiveDesktopUpdate(generatedStatus({phase:'downloading',progressPercent:40}));
  find(ui.draw(), 'updates-cancel').click(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['getDesktopUpdateStatus','checkDesktopUpdate','installDesktopUpdate','cancelDesktopUpdate'].map(name => [name, []]));
});

test('update events preserve unrelated form state, and IPC failures stay controlled', async () => {
  const ui = fixture({checkDesktopUpdate: async () => { throw Error('PRIVATE_DIAGNOSTIC /private/path token=secret'); }});
  ui.context.settingsTab = 'downloads';
  const before = JSON.stringify(ui.context.state); ui.receiveDesktopUpdate(generatedStatus()); assert.equal(ui.context.renders, 0); assert.equal(JSON.stringify(ui.context.state), before);
  await ui.requestDesktopUpdate('check');
  assert.equal(ui.context.desktopUpdate.phase, 'failed'); assert.ok(!/PRIVATE_|token=|private\/path/.test(JSON.stringify(ui.context.desktopUpdate)));
  ui.context.settingsTab = 'updates'; const panel = ui.draw(); assert.match(find(panel, 'updates-next-action').textContent, /Check for updates again/);
});

test('preload exposes only parameterless updater methods and an unsubscribeable status event', () => {
  const source = fs.readFileSync('dist/desktop/preload.js','utf8');
  let bridge; const calls = [], listeners = new Map();
  vm.runInNewContext(source, {exports:{},require(){return {contextBridge:{exposeInMainWorld(_name,value){bridge=value;}},ipcRenderer:{invoke(...args){calls.push(args);return Promise.resolve();},on(name,handler){listeners.set(name,handler);},removeListener(name,handler){assert.equal(listeners.get(name),handler);listeners.delete(name);}}};}});
  for (const method of ['getDesktopUpdateStatus','checkDesktopUpdate','installDesktopUpdate','cancelDesktopUpdate']) bridge[method]('ignored');
  assert.deepEqual(calls, ['getDesktopUpdateStatus','checkDesktopUpdate','installDesktopUpdate','cancelDesktopUpdate'].map(name=>[name]));
  const seen=[]; const unsubscribe=bridge.onDesktopUpdateStatus(value=>seen.push(value)); const value=generatedStatus();listeners.get('desktop-update-status')({},value); assert.equal(seen[0],value);unsubscribe();assert.equal(listeners.size,0);
});
