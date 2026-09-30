// Builds the in-browser receipt verifier (site/src/verifier.ts, which reuses
// the SDK's receipt code) into site/js/verifier.js. Run from the repo root:
//   node site/build.mjs
// esbuild comes from the app's dependencies (cd app && pnpm install), the
// noble libraries from the SDK's (cd sdk && npm install).
import { createRequire } from 'node:module';

const require = createRequire(new URL('../app/package.json', import.meta.url));
const { build } = require('esbuild');

const r = await build({
  entryPoints: [new URL('src/verifier.ts', import.meta.url).pathname],
  outfile: new URL('js/verifier.js', import.meta.url).pathname,
  bundle: true,
  nodePaths: [new URL('../sdk/node_modules', import.meta.url).pathname],
  format: 'esm',
  target: 'es2020',
  minify: true,
  legalComments: 'none',
  metafile: true,
  banner: { js: '// envolvr receipt verifier. Source: site/src/verifier.ts and sdk/src/receipts.ts.' },
});
for (const [file, o] of Object.entries(r.metafile.outputs)) console.log(`${(o.bytes / 1024).toFixed(0)} kB  ${file}`);
