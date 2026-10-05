// Builds the in-browser receipt verifier (verifier/verifier.ts, which reuses
// the SDK's receipt code) into the file envolvr.xyz serves as js/verifier.js.
// Run from the repo root:
//   node verifier/build.mjs [outfile]   (default: site/public/js/verifier.js,
//                                        a checkout of the site beside this repo)
// esbuild comes from the app's dependencies (cd app && pnpm install), the
// noble libraries from the SDK's (cd sdk && npm install).
import { createRequire } from 'node:module';

const require = createRequire(new URL('../app/package.json', import.meta.url));
const { build } = require('esbuild');

const r = await build({
  entryPoints: [new URL('verifier.ts', import.meta.url).pathname],
  outfile: process.argv[2] ?? new URL('../site/public/js/verifier.js', import.meta.url).pathname,
  bundle: true,
  nodePaths: [new URL('../sdk/node_modules', import.meta.url).pathname],
  format: 'esm',
  target: 'es2020',
  minify: true,
  legalComments: 'none',
  metafile: true,
  banner: { js: '// envolvr receipt verifier. Source: github.com/envolvr/envolvr, verifier/verifier.ts and sdk/src/receipts.ts.' },
});
for (const [file, o] of Object.entries(r.metafile.outputs)) console.log(`${(o.bytes / 1024).toFixed(0)} kB  ${file}`);
