// Weights manifests for envolvr attested weights (spec: docs/attested-weights.md).
//
// A manifest lists every file of a model revision that can change inference
// output, with its SHA-256. The weights root commits to the whole manifest:
//
//   fileLeaf   = SHA-256( utf8(path) || 0x00 || fileSha256 )
//   weightsRoot = Merkle root over fileLeaf, files sorted by path (bytewise),
//                 built exactly like receipt batches (anchorer/src/merkle.ts).
//
// The same root comes out of two independent paths: from the hub's published
// per-file hashes (reference) and from hashing the files on disk (boot step).

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { buildBatch, toHex, type Hex } from '../../anchorer/src/merkle.ts';

export const SELECTION = 'envolvr.weights.selection.v1';

const EXTENSIONS = ['.safetensors', '.json', '.jinja', '.tiktoken'];
const BASENAMES = ['tokenizer.model', 'merges.txt', 'vocab.txt'];

/** Selection v1: files that can change inference output. Docs, licenses, eval
 * results, hidden paths and `original/` checkpoints are excluded. */
export function isSelected(path: string): boolean {
  const segments = path.split('/');
  if (segments.some((s) => s.startsWith('.'))) return false;
  if (segments[0] === 'original') return false;
  const base = segments[segments.length - 1];
  return BASENAMES.includes(base) || EXTENSIONS.some((ext) => base.endsWith(ext));
}

export interface ManifestFile {
  path: string;
  size: number;
  sha256: string;
}

export interface Manifest {
  selection: typeof SELECTION;
  repo?: string;
  revision?: string;
  files: ManifestFile[];
  weightsRoot: Hex;
}

function byPath(a: ManifestFile, b: ManifestFile): number {
  return Buffer.compare(Buffer.from(a.path, 'utf8'), Buffer.from(b.path, 'utf8'));
}

export function fileLeaf(file: ManifestFile): Hex {
  const sha = Buffer.from(file.sha256, 'hex');
  if (sha.length !== 32) throw new Error(`bad sha256 for ${file.path}`);
  const digest = createHash('sha256').update(Buffer.from(file.path, 'utf8')).update(Buffer.of(0)).update(sha).digest();
  return toHex(digest);
}

export function buildManifest(files: ManifestFile[], meta: { repo?: string; revision?: string } = {}): Manifest {
  const selected = files.filter((f) => isSelected(f.path)).sort(byPath);
  if (selected.length === 0) throw new Error('no weight files selected');
  const paths = new Set(selected.map((f) => f.path));
  if (paths.size !== selected.length) throw new Error('duplicate paths in manifest');
  return { selection: SELECTION, ...meta, files: selected, weightsRoot: buildBatch(selected.map(fileLeaf)).root };
}

export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/** Boot step: hash the files on disk. Files are hashed in parallel, since model
 * weights are large and hosts have many cores. */
export async function manifestFromDirectory(dir: string, concurrency = 8): Promise<Manifest> {
  const paths = (await walk(dir)).map((p) => relative(dir, p).split(sep).join('/')).filter(isSelected);
  const files: ManifestFile[] = new Array(paths.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, paths.length) }, async () => {
      while (next < paths.length) {
        const i = next++;
        const full = join(dir, paths[i]);
        files[i] = { path: paths[i], size: (await stat(full)).size, sha256: await sha256File(full) };
      }
    }),
  );
  return buildManifest(files);
}

interface HubSibling {
  rfilename: string;
  size?: number;
  lfs?: { sha256: string; size: number };
}

/** Reference: large files take the hub's published LFS SHA-256; small files are
 * downloaded and hashed, since the hub reports only git blob ids for them. */
export async function manifestFromHub(repo: string, revision: string, token?: string): Promise<Manifest> {
  const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
  const api = `https://huggingface.co/api/models/${repo}/revision/${revision}?blobs=true`;
  const res = await fetch(api, { headers });
  if (!res.ok) throw new Error(`hub metadata ${res.status} for ${repo}@${revision}`);
  const info = (await res.json()) as { sha: string; siblings: HubSibling[] };
  if (info.sha !== revision) throw new Error(`revision must be a full commit sha (hub resolved ${info.sha})`);

  const files: ManifestFile[] = [];
  for (const s of info.siblings.filter((s) => isSelected(s.rfilename))) {
    if (s.lfs) {
      files.push({ path: s.rfilename, size: s.lfs.size, sha256: s.lfs.sha256 });
      continue;
    }
    const url = `https://huggingface.co/${repo}/resolve/${revision}/${s.rfilename}`;
    const body = await fetch(url, { headers });
    if (!body.ok) throw new Error(`download ${body.status} for ${s.rfilename}`);
    const bytes = Buffer.from(await body.arrayBuffer());
    files.push({ path: s.rfilename, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  return buildManifest(files, { repo, revision });
}
