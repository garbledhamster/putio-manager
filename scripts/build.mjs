import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const packageFile = require.resolve('typescript/package.json');
const compiler = path.resolve(path.dirname(packageFile), JSON.parse(await readFile(packageFile, 'utf8')).bin.tsc);
function compile(args) {
  const result = spawnSync(process.execPath, [compiler, ...args], { stdio: 'inherit' });
  if (result.error || result.status !== 0) process.exit(result.status || 1);
}

// Keep the shared error vocabulary in each runtime's existing module format.
compile(['-p', 'tsconfig.ui.json']);
const browserMessages = await readFile('dist/messages/user-messages.js');
compile([]);
await mkdir('dist/ui', { recursive: true });
await writeFile('dist/ui/user-messages.js', browserMessages);
await import('./copy-assets.mts');
