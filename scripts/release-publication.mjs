import { spawnSync } from 'node:child_process';
import { appendFile, readFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHECKSUM_NAME, hashReleaseFile, inspectReleaseAssets, stableVersion } from './release-catalog.mjs';
import { verifySignedUpdates } from './sign-updates.mjs';

const repository = 'garbledhamster/putio-manager';
export function validateBuildRun(run, expectedRepository, expectedRunId) {
  if (expectedRepository !== repository || !/^\d+$/.test(String(expectedRunId)) || String(run.id) !== String(expectedRunId) || run.repository?.full_name !== repository || run.head_repository?.full_name !== repository || run.path !== '.github/workflows/build.yml' || run.status !== 'completed' || run.conclusion !== 'success' || run.head_branch !== 'main' || !['push', 'workflow_dispatch'].includes(run.event) || !/^[a-f0-9]{40}$/.test(run.head_sha)) throw new Error('Publication requires a verified successful main repository build.');
  return run.head_sha;
}
export function validateReleaseUpload(release, local, version, sha, draft) {
  stableVersion(version);
  if (!/^[a-f0-9]{40}$/.test(sha) || release.draft !== draft || release.prerelease !== false || release.tag_name !== `v${version}` || release.target_commitish !== sha || !Array.isArray(release.assets) || release.assets.length !== local.length) throw new Error('Release does not match the verified publication.');
  const uploaded = new Map();
  for (const asset of release.assets) {
    if (uploaded.has(asset.name) || asset.state !== 'uploaded') throw new Error('Release assets are duplicated or incomplete.');
    uploaded.set(asset.name, asset);
  }
  for (const asset of local) {
    const remote = uploaded.get(asset.name);
    if (!remote || remote.size !== asset.bytes || remote.digest !== `sha256:${asset.sha256}`) throw new Error('Release asset checksum verification failed.');
  }
  return true;
}
export function findReleaseByVersion(version, request) {
  stableVersion(version);
  const tag = `v${version}`, published = request(`repos/${repository}/releases/tags/${tag}`, true);
  if (published) return published;
  let found;
  for (let page = 1; page <= 100; page++) {
    const releases = request(`repos/${repository}/releases?per_page=100&page=${page}`);
    if (!Array.isArray(releases) || releases.length > 100) throw new Error('GitHub release listing is invalid.');
    for (const release of releases.filter(item => item.tag_name === tag)) {
      if (found) throw new Error('Ambiguous unfinished releases must be preserved for review.');
      if (!Number.isSafeInteger(release.id) || release.id < 1) throw new Error('GitHub release identity is invalid.');
      found = release;
    }
    if (releases.length < 100) {
      if (!found) return undefined;
      const release = request(`repos/${repository}/releases/${found.id}`);
      if (release.id !== found.id || release.tag_name !== tag) throw new Error('GitHub release identity changed.');
      return release;
    }
  }
  throw new Error('GitHub release listing exceeded its verification bound.');
}
export function versionState(version, request) {
  stableVersion(version);
  const tag = request(`repos/${repository}/git/ref/tags/v${version}`, true), release = findReleaseByVersion(version, request);
  if (release?.draft || (!tag && release)) throw new Error('An unfinished release already exists; preserve it for review.');
  return { version, skip: tag ? 'true' : 'false' };
}
export function publishVerifiedRelease(directory, assets, version, sha, request, execute) {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Invalid publication source.');
  if (versionState(version, request).skip === 'true') throw new Error('Existing versions must never be overwritten.');
  const tag = `v${version}`;
  const created = JSON.parse(execute(['api', '--method', 'POST', `repos/${repository}/releases`, '-f', `tag_name=${tag}`, '-f', `target_commitish=${sha}`, '-F', 'draft=true', '-F', 'prerelease=false', '-f', `name=Putio Manager ${version}`, '-f', 'body=Verified portable bundles and desktop installers for Windows, macOS and Linux, with signed update metadata. Windows installers are unsigned; download checksums and update signatures verify the published bytes. Documentation images use generated demonstration data.']));
  if (!Number.isSafeInteger(created.id) || created.id < 1 || created.tag_name !== tag || created.target_commitish !== sha || created.draft !== true || created.prerelease !== false) throw new Error('Created draft does not match the verified publication.');
  const endpoint = `repos/${repository}/releases/${created.id}`;
  execute(['release', 'upload', tag, ...assets.map(asset => path.join(directory, asset.name)), '--repo', repository]);
  const uploaded = request(endpoint);
  if (uploaded.id !== created.id) throw new Error('GitHub release identity changed.');
  validateReleaseUpload(uploaded, assets, version, sha, true);
  const existingTag = request(`repos/${repository}/git/ref/tags/${tag}`, true);
  if (existingTag && (existingTag.object?.type !== 'commit' || existingTag.object.sha !== sha)) throw new Error('Publication tag changed and does not match the verified commit.');
  execute(['api', '--method', 'PATCH', endpoint, '-F', 'draft=false', '-F', 'prerelease=false', '-f', 'make_latest=true']);
  const published = request(endpoint);
  if (published.id !== created.id) throw new Error('GitHub release identity changed.');
  validateReleaseUpload(published, assets, version, sha, false);
  const publishedTag = request(`repos/${repository}/git/ref/tags/${tag}`);
  if (publishedTag.object?.type !== 'commit' || publishedTag.object.sha !== sha) throw new Error('Published source tag does not match the verified commit.');
}
function gh(args) {
  const result = spawnSync('gh', args, { encoding: 'utf8', timeout: args[1] === 'upload' ? 1200000 : 120000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
  if (result.error || result.status !== 0) throw new Error('GitHub publication request failed.');
  return result.stdout;
}
function getJson(endpoint, missingAllowed = false) {
  const result = spawnSync('gh', ['api', '--include', endpoint], { encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
  const status = /^HTTP\/[\d.]+\s+(\d+)/.exec(result.stdout || '')?.[1];
  if (status === '404' && missingAllowed) return undefined;
  if (result.error || result.status !== 0 || status !== '200') throw new Error('GitHub release verification request failed.');
  const boundary = result.stdout.search(/\r?\n\r?\n/);
  if (boundary < 0) throw new Error('GitHub release verification response failed.');
  return JSON.parse(result.stdout.slice(boundary).trim());
}
async function output(values) {
  if (!process.env.GITHUB_OUTPUT) throw new Error('This command requires a CI output channel.');
  await appendFile(process.env.GITHUB_OUTPUT, Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(''));
}
async function localPublished(directory, version) {
  const { UPDATE_PUBLIC_KEY_PEM } = await import('../src/desktop/update-public-key.ts');
  await verifySignedUpdates(directory, version, UPDATE_PUBLIC_KEY_PEM);
  const assets = await inspectReleaseAssets(directory, version, 'published');
  const checksum = path.join(directory, CHECKSUM_NAME), stat = await lstat(checksum);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536 || await readFile(checksum, 'utf8') !== `${assets.map(asset => `${asset.sha256}  ${asset.name}`).join('\n')}\n`) throw new Error('Publication checksum manifest verification failed.');
  return [...assets, { name: CHECKSUM_NAME, ...await hashReleaseFile(checksum) }];
}
async function main() {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_REPOSITORY !== repository) throw new Error('Publication requires the owning repository CI.');
  const [command, value, suppliedSha] = process.argv.slice(2);
  if (command === 'validate-run') {
    if (!/^\d+$/.test(value)) throw new Error('Invalid build run.');
    const sha = validateBuildRun(getJson(`repos/${repository}/actions/runs/${value}`), repository, value);
    await output({ sha }); console.log('Verified native main-branch build provenance.'); return;
  }
  const { version } = JSON.parse(await readFile('package.json', 'utf8')); stableVersion(version);
  if (command === 'version-state') {
    const state = versionState(version, getJson);
    await output(state);
    console.log(state.skip === 'true' ? 'This version already exists; publication skipped.' : 'New stable version is eligible for verified publication.'); return;
  }
  if (command !== 'publish' || !/^[a-f0-9]{40}$/.test(suppliedSha)) throw new Error('Invalid publication command.');
  const assets = await localPublished(value, version);
  publishVerifiedRelease(value, assets, version, suppliedSha, getJson, gh);
  console.log('Published the complete verified release; source tag and every uploaded asset match.');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => { console.error('Verified publication could not complete. Existing releases and unfinished drafts were preserved. No private values were printed.'); process.exitCode = 1; });
