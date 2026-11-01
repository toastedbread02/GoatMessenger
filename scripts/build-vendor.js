// Builds app/vendor/noble.mjs — a single, dependency-free ES module holding the
// primitives used by app/shared/crypto.mjs. Node specs and the renderer then
// execute exactly the same crypto code.
const esbuild = require('esbuild');
const path = require('path');

const out = path.join(__dirname, '..', 'app', 'vendor', 'noble.mjs');
esbuild.buildSync({
  entryPoints: [path.join(__dirname, 'noble-entry.mjs')],
  outfile: out,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2020'],
  legalComments: 'inline',
});
console.log('vendor written ->', out);
