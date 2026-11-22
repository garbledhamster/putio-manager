const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { presentUserError, classifyUserError } = require(process.env.PUTIO_TEST_SOURCE_MESSAGES
  ? '../src/messages/user-messages.ts' : '../dist/messages/user-messages.js');

const observed = [
  ['Staging anchor cleanup requires attention.', 'temporary-cleanup'],
  ['Published destination could not be verified.', 'destination-unverified'],
  ["The previous download's partial file was unavailable during migration.", 'partial-missing'],
  ['Download failed.', 'unknown'],
  ['Destination already exists; its contents were not verified.', 'destination-exists'],
];

const examples = [
  ...observed,
  ['Staging or destination is full; any owned bytes were retained. Free space and retry.', 'storage-full'],
  ['Insufficient staging capacity or free-space reserve.', 'storage-limit'],
  ['Could not determine available storage.', 'storage-check'],
  ['Could not verify that the staging directory is writable; inspect its permissions.', 'storage-access'],
  ['Staging or destination I/O failed; any owned bytes were retained. Inspect access and retry.', 'storage-io'],
  ['Staging or destination cannot create a safe ownership anchor; inspect filesystem support.', 'filesystem-unsupported'],
  ['Staged or destination bytes could not be verified; source was retained.', 'content-mismatch'],
  ['A staged file close is unresolved; exit the engine if it cannot be reconciled.', 'file-close-unconfirmed'],
  ['Could not safely close stage artifact.', 'file-close-unconfirmed'],
  ['Staging artifact ownership is unknown.', 'file-check-required'],
  ['Saved staging recovery requires attention.', 'recovery-check'],
  ['Source changed; retry to accept the refreshed source.', 'source-changed'],
  ['Source identity unavailable.', 'source-unavailable'],
  ['Source folder cleanup outcome is unknown.', 'source-cleanup-unknown'],
  ['Source cleanup failed.', 'source-cleanup-failed'],
  ['Source cleanup was not started.', 'source-cleanup-not-started'],
  ['Could not save job state; retry was not scheduled.', 'state-save'],
  ['Could not read engine state.', 'state-read'],
  ['State directory is already owned by a running engine.', 'already-running'],
  ['Token was rejected. Check Settings.', 'putio-authorization'],
  ['Remote authorization failed.', 'server-authorization'],
  ['Could not unlock the remote server credential.', 'credential-storage'],
  ['Could not connect to put.io.', 'putio-network'],
  ['Could not connect to remote engine.', 'server-network'],
  ['Remote engine version is incompatible. Update the remote server before using it.', 'server-version'],
  ['Invalid remote response.', 'server-response'],
  ['put.io returned an invalid response.', 'putio-response'],
  ['put.io request failed (429).', 'putio-request'],
  ['put.io could not move the item to this folder.', 'move-rejected'],
  ['Could not open the account link.', 'account-link'],
  ['Connection timed out. Try connecting again.', 'account-link-expired'],
  ['Request canceled.', 'canceled'],
  ['Concurrency must be between 1 and 20.', 'parallel-range'],
  ['Interval must be between 10 and 86400 seconds.', 'interval-range'],
  ['Speed limit must be zero or a positive whole number of bytes per second.', 'speed-range'],
  ['Speed must be zero or a positive number.', 'speed-value'],
  ['Minimum size must be a non-negative number.', 'minimum-size'],
  ['Interval must be a positive whole number of seconds.', 'interval-range'],
  ['Choose a valid schedule time.', 'schedule-time'],
  ['Select a put.io folder in Files before adding a rule.', 'rule-folder-choice'],
  ['Could not confirm the magnet destination.', 'magnet-destination'],
  ['Item moved. Refresh Files to update the folder listing.', 'move-refresh'],
  ['The download disk is full.', 'storage-full'],
  ['Download folder access was denied.', 'storage-access'],
  ['The download disk could not read or write data.', 'storage-io'],
  ['The server staging directory changed. Staging is off; review the path and re-enable it for new downloads.', 'temporary-folder-changed'],
  ['Invalid staging budget.', 'staging-budget'],
  ['Invalid staging reserve.', 'staging-reserve'],
  ['Choose an absolute download directory.', 'folder-choice'],
  ['Enter a valid folder name.', 'folder-name'],
  ['Staging directory must be separate from the download directory.', 'staging-settings'],
  ['Invalid settings.', 'settings-invalid'],
  ['Invalid rule.', 'rule-invalid'],
  ['Invalid remote endpoint.', 'server-settings'],
  ['Job cannot be retried.', 'action-unavailable'],
  ['Engine is paused.', 'paused'],
  ['Interrupted by engine restart; retry explicitly.', 'interrupted'],
  ['Scan failed. Check connection and rules.', 'scan-failed'],
  ['Invalid magnet link.', 'magnet-invalid'],
  ['Use ZIP download for folders.', 'zip-required'],
  ['Ambiguous folder contents.', 'folder-changed'],
  ['The operating system did not confirm login startup.', 'startup-setting'],
  ['Remote server folders cannot be opened on this computer.', 'folder-open'],
];

for (const [raw, code] of examples) {
  test(`controlled category: ${code}: ${raw}`, () => {
    const result = presentUserError(raw, {host:'remote', status:'needs-attention'});
    assert.equal(result.code, code);
    assert.equal(classifyUserError(new Error(raw)), code);
    for (const field of ['title', 'explanation', 'nextAction', 'message']) assert.ok(result[field].length > 0);
    assert.equal(result.message, `${result.title} ${result.explanation} ${result.nextAction}`);
    assert.doesNotMatch(result.message, /\b(anchor|artifact|inode|migration|publication|ownership|engine)\b/i);
  });
}

test('all controlled messages use short sentences with direct next actions', () => {
  const seen = new Set();
  for (const [raw] of examples) for (const host of ['local', 'remote']) {
    const message = presentUserError(raw, {host, status:'needs-attention'});
    seen.add(message.code);
    for (const sentence of message.message.replace(/put\.io/g, 'putio').split(/[.!?]+/).filter(s => s.trim())) {
      assert.ok(sentence.trim().split(/\s+/).length <= 20, `${message.code}: ${sentence}`);
    }
  }
  assert.equal(seen.size, 63);
});

test('unknown and hostile diagnostics never return raw names, paths, credentials, URLs, or file contents', () => {
  const sensitive = 'SECRET_ACCESS_TOKEN_abc123';
  const inputs = [
    `${sensitive} C:\\Private\\family.mov https://user:pass@example.test/private?token=secret`,
    {message:`ENOSPC: ${sensitive}`, code:'ENOSPC', path:'C:\\private', content:'MEDIA_CONTENT'},
    {message:`Token was rejected. ${sensitive}`, kind:'authorization'},
    {message:`Staging artifact ownership is unknown. ${sensitive}`},
    null, undefined, 123, Symbol('private'), {message:{secret:sensitive}},
    {toString(){throw new Error(sensitive);}},
    Object.defineProperty({}, 'message', {get(){throw new Error(sensitive);}}),
  ];
  for (const input of inputs) {
    const result = presentUserError(input, {host:'remote'});
    assert.deepEqual(Object.keys(result).sort(), ['code','explanation','message','nextAction','title']);
    assert.doesNotMatch(JSON.stringify(result), /SECRET_ACCESS_TOKEN|family\.mov|https?:|user:pass|MEDIA_CONTENT|C:\\/);
  }
  const unknown = presentUserError('Download failed.');
  assert.equal(unknown.code, 'unknown');
  assert.match(unknown.message, /stopped|automatic solution/);
  assert.match(unknown.nextAction, /Check|Contact support/);
  assert.doesNotMatch(unknown.message, /disk is full|account needs|Select Retry|safe file|source.*retained/i);
});

test('specific disk and credential errors do not collapse to generic download errors', () => {
  assert.equal(classifyUserError({code:'ENOSPC',message:'write failed'}), 'storage-full');
  assert.equal(classifyUserError({code:'EACCES',message:'open failed'}), 'storage-access');
  assert.equal(classifyUserError({code:'EIO',message:'write failed'}), 'storage-io');
  assert.equal(classifyUserError({code:'ENOTSUP',message:'operation failed'}), 'filesystem-unsupported');
  assert.equal(classifyUserError({kind:'authorization',message:'request failed'}), 'putio-authorization');
  assert.equal(classifyUserError('Invalid client credential.'), 'server-authorization');
  assert.doesNotMatch(presentUserError({code:'ENOSPC'}).message, /credential|authorization/);
  assert.doesNotMatch(presentUserError('Invalid client credential.').message, /disk is full|put.io account needs/);
});

test('inspection states do not direct repeated retry or manual file deletion', () => {
  for (const raw of [observed[0][0],observed[1][0],observed[2][0], 'Staging artifact ownership is unknown.', 'Download file could not be safely closed.']) {
    const result = presentUserError(raw, {status:'needs-attention'});
    assert.match(result.nextAction, /Contact support/);
    assert.doesNotMatch(result.nextAction, /^Select Retry|retry again|delete|remove|safe to retry/i);
  }
});

test('verification claims require explicit completed and verified context', () => {
  for (const context of [{}, {verification:'verified',status:'needs-attention'}, {status:'completed',verification:'unverified'}]) {
    const result = presentUserError('The verified output is safe, but its staged copy could not be removed.', context);
    assert.match(result.explanation, /not confirmed/);
    assert.doesNotMatch(result.message, /file passed verification|file is safe|source.*retained/);
  }
  const verified = presentUserError('The verified output is safe, but its staged copy could not be removed.', {job:{status:'completed',verification:'verified'}});
  assert.match(verified.explanation, /file passed verification/);
  assert.match(verified.explanation, /Temporary download files can remain/);
  assert.equal(presentUserError('Published destination could not be verified.', {status:'completed',verification:'verified'}).code, 'destination-unverified');
});

test('cleanup uncertainty never implies the put.io source remains or deletion is safe', () => {
  for (const context of [{cleanupStatus:'unknown'}, {cleanupStatus:'failed',cleanupPending:true}, {job:{cleanupStatus:'unknown',status:'completed',verification:'verified'}}]) {
    const result = presentUserError('Source cleanup failed.', context);
    assert.equal(result.code, 'source-cleanup-unknown');
    assert.match(result.message, /cannot confirm whether put.io deleted/);
    assert.doesNotMatch(result.message, /source (is safe|was retained|remains|is still|was not deleted)/i);
    assert.match(result.nextAction, /Check the source.*before/);
  }
  const notStarted = presentUserError('Source retained because its identity could not be revalidated.');
  assert.equal(notStarted.code, 'source-cleanup-not-started');
  assert.doesNotMatch(notStarted.message, /source was retained|source remains|source is safe/);
});

test('host terminology identifies where to inspect without exposing host labels', () => {
  const local = presentUserError('Download file could not be safely closed.', {host:'local'}).message;
  const remote = presentUserError('Download file could not be safely closed.', {host:'remote'}).message;
  assert.match(local, /this computer/);
  assert.match(remote, /download server/);
  assert.doesNotMatch(remote, /this computer|remote engine/);
});

test('server connection guidance allows startup checks without claiming the cause', () => {
  const result = presentUserError('Could not connect to remote engine.', {host:'remote'});
  assert.equal(result.code, 'server-network');
  assert.match(result.explanation, /After a restart.*can need time.*check saved downloads/);
  assert.match(result.nextAction, /If the server restarted, wait/);
  assert.match(result.nextAction, /If this continues, check the server service and private network connection/);
  assert.doesNotMatch(result.message, /server is restarting|server is checking|network is broken|file is safe|source was retained/i);
});

test('field validation preserves only controlled allowed ranges', () => {
  for (const [raw, expected] of [
    ['Concurrency must be between 1 and 20. secret=abc', /1 to 20/],
    ['Interval must be between 10 and 86400 seconds. token=xyz', /10 to 86400 seconds/],
    ['Speed limit must be zero or a positive whole number of bytes per second. private=data', /zero or a positive whole number of bytes per second/],
  ]) {
    const result = presentUserError(raw);
    assert.match(result.message, expected);
    assert.doesNotMatch(result.message, /secret=|token=|private=/);
  }
});

test('changed server temporary folder notice preserves disabled behavior for new downloads', () => {
  const result = presentUserError('The server staging directory changed. Staging is off; review the path and re-enable it for new downloads.', {host:'remote'});
  assert.equal(result.code, 'temporary-folder-changed');
  assert.match(result.explanation, /New downloads will not use temporary storage until you enable it again/);
  assert.match(result.nextAction, /Review.*Settings.*only after you confirm the folder/);
  assert.doesNotMatch(result.message, /folder is unavailable|download failed|file is safe|source was retained/i);
});

test('known static core, engine, and remote errors have controlled categories', () => {
  // Keep the inventory tied to actual thrown and persisted diagnostics. Unknown arbitrary errors stay safe by default.
  const knownGeneric = new Set(['Download failed.']);
  for (const folder of ['core','engine','remote']) {
    const dir = path.join(__dirname, '../src', folder);
    for (const name of fs.readdirSync(dir).filter(name => name.endsWith('.ts'))) {
      const source = fs.readFileSync(path.join(dir,name), 'utf8');
      const literals = source.matchAll(/(?:new (?:Error|PutioRequestError|RemoteRequestError)\(|\.error = |cleanupWarning = |stagingWarning = )\s*(?:"[^"\n]*", )?"([^"\n]+)"/g);
      for (const [,raw] of literals) {
        if (!knownGeneric.has(raw)) assert.notEqual(classifyUserError(raw), 'unknown', `${folder}/${name}: ${raw}`);
      }
    }
  }
});
