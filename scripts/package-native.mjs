import { packager } from '@electron/packager';

// Only application code and the production dependency closure enter the package.
// Dependency source maps are unnecessary runtime data and may embed build paths.
await packager({
  dir: '.', name: 'PutioManager', out: 'release', overwrite: true, asar: false,
  ignore: [/^\/(?!dist(?:$|\/)|package\.json$|node_modules(?:$|\/))/, /\/node_modules\/.*\.map$/i],
  prune: true,
  protocols: [{ name: 'Magnet links', schemes: ['magnet'] }],
  icon: 'src/ui/branding/putio-manager',
  extraResource: ['LICENSE'],
});
