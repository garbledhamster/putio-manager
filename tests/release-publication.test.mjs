import test from 'node:test';
import assert from 'node:assert/strict';
const publication = await import('../scripts/release-publication.mjs').catch(() => ({}));
const repository = 'garbledhamster/putio-manager', sha = 'a'.repeat(40);
function run() { return { id: 12, repository: { full_name: repository }, head_repository: { full_name: repository }, path: '.github/workflows/build.yml', status: 'completed', conclusion: 'success', head_branch: 'main', event: 'push', head_sha: sha }; }
test('publication accepts only a successful native build from the exact main repository', () => {
  assert.equal(typeof publication.validateBuildRun, 'function');
  assert.equal(publication.validateBuildRun(run(), repository, '12'), sha);
  for (const altered of [{ event: 'pull_request' }, { conclusion: 'failure' }, { head_sha: 'bad' }, { path: '.github/workflows/unreviewed.yml' }, { head_branch: 'feature' }, { head_repository: { full_name: 'foreign/fork' } }, { repository: { full_name: 'foreign/fork' } }, { id: 13 }]) assert.throws(() => publication.validateBuildRun({ ...run(), ...altered }, repository, '12'));
});
test('draft verification rejects missing, duplicate, extra or altered uploaded assets', () => {
  const local = [{ name: 'fixture.zip', bytes: 3, sha256: 'b'.repeat(64) }];
  const asset = { name: 'fixture.zip', size: 3, digest: `sha256:${'b'.repeat(64)}`, state: 'uploaded' };
  const draft = { draft: true, prerelease: false, tag_name: 'v2.2.0', target_commitish: sha, assets: [asset] };
  assert.equal(publication.validateReleaseUpload(draft, local, '2.2.0', sha, true), true);
  for (const assets of [[], [asset, asset], [asset, { ...asset, name: 'extra.exe' }], [{ ...asset, size: 4 }], [{ ...asset, digest: `sha256:${'c'.repeat(64)}` }], [{ ...asset, digest: null }], [{ ...asset, state: 'new' }]]) assert.throws(() => publication.validateReleaseUpload({ ...draft, assets }, local, '2.2.0', sha, true));
  for (const altered of [{ draft: false }, { prerelease: true }, { target_commitish: 'main' }, { tag_name: 'v2.1.0' }]) assert.throws(() => publication.validateReleaseUpload({ ...draft, ...altered }, local, '2.2.0', sha, true));
});
