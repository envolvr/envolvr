import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { buildManifest, isSelected, manifestFromDirectory, manifestFromHub, type ManifestFile } from '../src/manifest.ts';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const file = (path: string, content = path): ManifestFile => ({ path, size: content.length, sha256: sha(content) });

test('selection v1 keeps inference-relevant files and drops the rest', () => {
  for (const p of ['model-00001-of-00141.safetensors', 'config.json', 'chat_template.jinja', 'tokenizer.model',
    'merges.txt', 'vision/model.safetensors', 'tokenizer.json']) assert.ok(isSelected(p), p);
  for (const p of ['README.md', 'LICENSE', '.gitattributes', '.eval_results/hle.yaml', 'original/consolidated.00.pth',
    'original/params.json', 'notes.txt', 'figure.png']) assert.equal(isSelected(p), false, p);
});

test('root does not depend on listing order', () => {
  const files = ['b.safetensors', 'a.safetensors', 'config.json'].map((p) => file(p));
  assert.equal(buildManifest(files).weightsRoot, buildManifest([...files].reverse()).weightsRoot);
});

test('root commits to paths as well as contents', () => {
  const a = buildManifest([file('model-a.safetensors', 'x'), file('config.json', 'c')]);
  const b = buildManifest([file('model-b.safetensors', 'x'), file('config.json', 'c')]);
  assert.notEqual(a.weightsRoot, b.weightsRoot);
});

test('duplicate paths are rejected', () => {
  assert.throws(() => buildManifest([file('config.json'), file('config.json', 'other')]), /duplicate/);
});

test('boot step: one changed byte in the weights changes the root', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'weights-'));
  await mkdir(join(dir, 'sub'));
  await writeFile(join(dir, 'model.safetensors'), Buffer.alloc(1 << 20, 7));
  await writeFile(join(dir, 'config.json'), '{"layers":2}');
  await writeFile(join(dir, 'sub', 'tokenizer.json'), '{}');
  await writeFile(join(dir, 'README.md'), 'ignored');
  const before = await manifestFromDirectory(dir);
  assert.deepEqual(before.files.map((f) => f.path), ['config.json', 'model.safetensors', 'sub/tokenizer.json']);

  const weights = Buffer.alloc(1 << 20, 7);
  weights[123_456] = 8;
  await writeFile(join(dir, 'model.safetensors'), weights);
  const after = await manifestFromDirectory(dir);
  assert.notEqual(before.weightsRoot, after.weightsRoot);

  await writeFile(join(dir, 'README.md'), 'changed docs do not matter');
  assert.equal((await manifestFromDirectory(dir)).weightsRoot, after.weightsRoot);
});

// Network: reference (hub metadata) and boot step (files on disk) must agree.
// Run with NETWORK=1.
test('hub reference matches the files on disk', { skip: !process.env.NETWORK }, async () => {
  const repo = 'hf-internal-testing/tiny-random-LlamaForCausalLM';
  const revision = '9fb191250dd56d0ba7ec9785a025ed29c03d5998';
  const reference = await manifestFromHub(repo, revision);
  const dir = await mkdtemp(join(tmpdir(), 'hub-'));
  for (const f of reference.files) {
    const res = await fetch(`https://huggingface.co/${repo}/resolve/${revision}/${f.path}`);
    await writeFile(join(dir, f.path), Buffer.from(await res.arrayBuffer()));
  }
  assert.equal((await manifestFromDirectory(dir)).weightsRoot, reference.weightsRoot);
});
