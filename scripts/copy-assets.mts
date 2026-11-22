import { cp, mkdir } from 'node:fs/promises';
await mkdir('dist/ui', {recursive:true});
await cp('src/ui/index.html','dist/ui/index.html');
await cp('src/ui/styles.css','dist/ui/styles.css');
await cp('src/ui/assets','dist/ui/assets',{recursive:true});

await cp('LICENSE', 'dist/LICENSE');

await cp('src/ui/heroicons.css', 'dist/ui/heroicons.css');
await cp('src/ui/heroicons', 'dist/ui/heroicons', {recursive:true});

await cp('src/ui/branding', 'dist/ui/branding', {recursive:true});

