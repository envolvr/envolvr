// Builds the app into ../site/app/, which the Pages workflow publishes at
// https://envolvr.xyz/app/. WalletConnect is split into its own chunk and only
// loaded when a visitor chooses it.
import { build } from 'esbuild';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';

const out = new URL('../site/app/', import.meta.url).pathname;
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  splitting: true,
  format: 'esm',
  target: 'es2020',
  minify: true,
  sourcemap: false,
  outdir: `${out}assets`,
  chunkNames: 'chunk-[hash]',
  entryNames: '[name]-[hash]',
  metafile: true,
  legalComments: 'none',
  define: { 'process.env.NODE_ENV': '"production"', global: 'globalThis' },
}).then(async (r) => {
  const main = Object.entries(r.metafile.outputs).find(([, o]) => o.entryPoint === 'src/main.ts')[0].split('/').pop();
  const { readFileSync, writeFileSync } = await import('node:fs');
  writeFileSync(`${out}index.html`, readFileSync('index.html', 'utf8').replace('__MAIN__', `./assets/${main}`));
  copyFileSync('app.css', `${out}app.css`);
  for (const [file, o] of Object.entries(r.metafile.outputs)) console.log(`${(o.bytes / 1024).toFixed(0).padStart(6)} kB  ${file.split('/site/')[1] ?? file}`);
});
