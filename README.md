# envolvr

Private inference your agent can prove.

envolvr runs AI inference inside hardware-attested enclaves on confidential
GPUs, returns a signed receipt for every response, and anchors those receipts on
Robinhood Chain. Agents pay per request in USDG, or stake ENVOLVR for a share of
a daily inference budget.

```
agent ──> envolvr gateway (TDX enclave) ──> attested model enclave (confidential GPU)
               │  signed receipt per response
               ├──> control plane: API keys, pricing, metering (never sees prompts)
               └──> receipt batches ──> ReceiptAnchor on Robinhood Chain
```

## Layout

| Path | What |
|---|---|
| `contracts/` | Foundry. `ReceiptAnchor` (append-only receipt log), `WeightsRegistry` (attested-weights references), `EnvolvrToken`, `StakingAllowance` (pro-rata share of a capped daily budget), `CreditVault` (USDG deposits). |
| `control/` | Control plane for the gateway middleware: wallet sign-in and API keys, authorization, pricing, metering against staking allowances and USDG balances, deposit watcher, sanctions screening of every wallet (Chainalysis oracle) at sign-in, deposit and use, encrypted off-VM ledger backups sealed to the enclave, and receipt anchoring: the gateway's receipt digests go on chain in Merkle batches signed by an enclave-held key, with an inclusion proof for every receipt. |
| `anchorer/` | Merkle batches and proofs for `ReceiptAnchor` from receipt files (CLI); the reference for the control plane's automatic anchoring. |
| `weights/` | Weights manifests and roots, from hub metadata (reference) or files on disk (boot step). |
| `infra/` | `production/`: gateway plus control plane in one attested VM, with every source commit and image digest pinned in the measured compose. `gateway/`: gateway-only deploy. `simulator/`: dstack simulator image for local runs. |
| `docs/` | Attested weights design, published weights manifests, local end-to-end guide, upstream proposals. |

The gateway is a fork of
[Dstack-TEE/private-ai-gateway](https://github.com/Dstack-TEE/private-ai-gateway):
[envolvr/private-ai-gateway](https://github.com/envolvr/private-ai-gateway).

## Tests

```bash
cd contracts && forge test                 # 37 tests, including fuzzing
cd anchorer  && node --test test/*.test.ts  # Merkle batches, cross-checked with Solidity
cd weights   && node --test test/*.test.ts  # NETWORK=1 adds the hub cross-check
cd control   && pnpm install && pnpm test   # billing parity with the gateway, auth, metering, deposits, backups, anchoring, screening
```

Node 24 or later runs the TypeScript directly. `contracts/lib` holds git
submodules: clone with `--recurse-submodules`. For a full local run of gateway,
control plane and an attested upstream, see `docs/local-e2e.md`.

## Robinhood Chain testnet

Deployed September 2026 (chain 46630). Addresses, anchored batches, deposits and
published weights references: `contracts/deployments/robinhood-testnet.json`.
Explorer: https://explorer.testnet.chain.robinhood.com

## Design

- `docs/attested-weights.md`: proving the exact weights that served a request.
- `docs/proposals/aci-nested-constraints.md`: carrying attestation claims through
  nested ACI services.

## License

Apache-2.0
