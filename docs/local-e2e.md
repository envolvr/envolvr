# Local end-to-end run

Runs the real gateway binary on a simulated TEE, with its middleware pointed at
envolvr's control plane and RedPill as the upstream. Verified on 2026-09-23.

```
client -> gateway (simulated TEE) -> control plane (auth, pricing, metering)
                                  -> RedPill (verified ACI upstream) -> model VM
```

## 1. Simulated TEE

dstack publishes a prebuilt macOS simulator for Apple Silicon only (v0.5.3). On
an Intel Mac, run the Linux build in Docker with its socket bridged to TCP
(`infra/simulator/Dockerfile`). The gateway accepts an HTTP `dstack_endpoint`.

## 2. Gateway

Needs Rust 1.89 or later. Build with a pinned toolchain so the machine default is
untouched:

```bash
rustup toolchain install 1.98.1 --profile minimal
cd gateway && cargo +1.98.1 build --release --locked --bin private-ai-gateway
```

Config (keep it outside the repo: the upstream entry holds an API key):

```json
{
  "bind": "127.0.0.1:8086",
  "state_dir": "<tmp>/gw-state",
  "upstream_config_seed_path": "<tmp>/gw-upstreams.json",
  "dstack_endpoint": "http://127.0.0.1:8090",
  "admin_token": "<random>",
  "middleware": { "control_url": "http://127.0.0.1:8787", "control_token": "<CONTROL_TOKEN>" }
}
```

The upstream seed pins RedPill by its measured app id and Phala's production
KMS root, with a Phala Cloud Confidential AI key as `bearer_token`:

```json
[{
  "name": "redpill", "provider": "aci-service", "base_url": "https://api.redpill.ai",
  "models": { "z-ai/glm-5.3": "z-ai/glm-5.3" },
  "bearer_token": "<key>",
  "accepted_subjects": ["app-id:0xfdb7a14e5a6675f752e2cb69c9067a98ca402918"],
  "accepted_dstack_kms_root_public_keys": ["0334c76e0c3f52ec64cbf9bbf5c910c272330166fd656c0a86bb330963e46910e1"]
}]
```

The KMS root is recovered from RedPill's key-custody signature chain, and the
same derivation over any Phala-hosted workload gives the same value.

## 3. Control plane

```bash
cd control
CONTROL_CONFIG=<tmp>/control.json CONTROL_TOKEN=… ADMIN_TOKEN=… pnpm start
```

`control.json` is `config.example.json` with `dbPath` pointed somewhere
temporary.

## 4. Client

```bash
cd control && ADMIN_TOKEN=… node --disable-warning=ExperimentalWarning scripts/e2e.ts
```

Expected, as observed:

1. A fresh wallet signs in and gets an API key.
2. A request before credit is refused: 402 `insufficient credit`. An unknown key: 401.
3. After a $0.50 credit, a request returns 200 with a receipt whose event log is
   `request.received, middleware.forwarded, route.selected, request.forwarded,
   upstream.verified, response.received, response.returned`.
4. The gateway reports the cost from the control plane's pricing, and the
   control plane debits the same amount rounded up to the next micro-USD
   ($0.0003276 shown, 328 micro-USD billed).

The simulated TEE produces no source provenance, so verifiers reject its
attestation report. That is expected: this run tests the request path, auth and
billing, not attestation.
