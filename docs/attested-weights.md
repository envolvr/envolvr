# Attested weights

Status: design v1, reference tooling built (`weights/`). The model VM side depends
on Phala adopting the boot step: envolvr runs no GPUs of its own for now. September 2026.

## The claim

The exact model weights that served a request are measured inside the enclave
at boot, and they match a public reference. Anyone can check this without
trusting envolvr or the provider.

ACI already defines the claim, `model_weights_provenance` ("the served weights
match their claimed provenance"), but no live route asserts it. Phala's own
provider review lists it as "not derived, operator-asserted only". This document
specifies how to derive it.

## Weights manifest and root

A manifest lists every file of a model revision that can change inference
output, with its SHA-256.

**Selection v1** (`envolvr.weights.selection.v1`). A file is included when its
basename is `tokenizer.model`, `merges.txt` or `vocab.txt`, or its extension is
`.safetensors`, `.json`, `.jinja` or `.tiktoken`. It is excluded when any path
segment starts with `.` or the first segment is `original`. That covers weight
shards, the shard index, model and generation config, tokenizer files and the
chat template. It leaves out docs, licenses, eval results and duplicate
checkpoints.

**Root.** Files are sorted by path, bytewise on UTF-8.

```
fileLeaf    = SHA-256( utf8(path) || 0x00 || fileSha256 )
leaf        = keccak256( keccak256( fileLeaf ) )
inner node  = keccak256( min(a, b) || max(a, b) )
odd node    = carried up to the next level unchanged
weightsRoot = the single node left at the top
```

This is the same tree as receipt batches (`anchorer/src/merkle.ts`,
`contracts/src/ReceiptAnchor.sol`), so a single file's inclusion can be proven
on chain with the same code.

## Two paths, one root

- **Reference** (envolvr publishes): from the hub's metadata. Large files use
  the hub's published LFS SHA-256. The few small files (config, tokenizer config,
  chat template) are downloaded and hashed.
  `node weights/src/cli.ts reference <repo> <full-revision-sha>`
- **Boot step** (the model VM runs): hash the files on disk.
  `node weights/src/cli.ts local <model-dir>`

Tested: both paths give the same root on a real repository mixing large and
small files (`weights/test/manifest.test.ts`, run with `NETWORK=1`). One changed
byte in a weight file changes the root; changed docs do not.

**Worked example.** `zai-org/GLM-5.3` at `aca966e4e02791568aa6a4ced368624b3d897f42`:
147 files, 755 GB, weights root
`0x4a74f09c8c2fc635436fc6011d55ffc31fa88016c50ca7a1204b65cba8ea02ac`.
Computed from hub metadata in about 11 seconds.

## Boot step in the model VM

For a dstack model VM (Phala's vllm-proxy or inference-guard deployments):

1. The measured compose pins `repo` and a full `revision` SHA. A branch name is
   never accepted.
2. Download the snapshot to a dedicated path. Hash every selected file, or hash
   while loading: the loader reads the same bytes, so hashing during load adds
   almost nothing to boot time. Hashing separately at NVMe speed takes minutes for
   755 GB.
3. Before serving, call dstack `EmitEvent` with event name `envolvr.weights.v1`
   and, as the payload, the JCS of
   `{"repo":…,"revision":…,"selection":"envolvr.weights.selection.v1","weightsRoot":"0x…"}`.
   This extends RTMR3, so the root is in every later quote and cannot be removed
   or replaced.
4. Remount the path read-only and serve only from it. If download, hashing or
   the event fails, do not serve.

The code that runs steps 2 to 4 is in the measured compose, so its behaviour is
covered by the same attestation.

## Verifier

In the gateway's Phala-direct adapter (`private-ai-gateway`, Apache-2.0):

1. Verify the quote and replay RTMR3 as today.
2. Find the `envolvr.weights.v1` event and parse its payload.
3. Look up the reference for `(repo, revision)` in `WeightsRegistry` on Robinhood
   Chain (`contracts/src/WeightsRegistry.sol`), or in a pinned local copy.
4. On match, assert `model_weights_provenance` with source `verifier_derived`
   and a reason naming the repo, revision and root. On mismatch, refute it. With
   no event, leave it `unknown`.

envolvr's gateway then accepts only sessions where the claim is asserted, and
the receipt cites that session.

## Trust assumptions

- The TEE and dstack's RTMR3 event log are sound.
- The measured compose is reviewed: it hashes the files it serves and serves
  only from the read-only path.
- The reference is correct. It is recomputable from public data by anyone, so a
  wrong reference is detectable.

## What we need from Phala

1. Agreement on the event name and payload above.
2. The boot step in the model VM image or compose for the launch models,
   starting with GLM-5.3. envolvr can contribute the patch.
3. Partner credentials for the Phala-direct endpoints, so envolvr's gateway can
   route straight to model VMs and carry their claims in its own sessions.

envolvr contributes the verifier change and publishes references on chain.
