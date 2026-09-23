# Proposal: carry claims through nested ACI services

For: `Dstack-TEE/private-ai-gateway`. Status: draft. September 2026.

## Problem

A gateway can use another ACI service as its upstream (`provider: aci-service`),
as envolvr does with RedPill. The outer gateway verifies the inner service's
gateway and records a session for it. That session can assert only
`tee_attested`, because the outer gateway sees the inner gateway, not the model
VM behind it.

The inner service does hold stronger sessions for its own upstreams:
Phala-direct model VMs with `gpu_attested`, `tcb_up_to_date` and `os_known_good`
asserted, and eventually `model_weights_provenance`. None of that reaches the
outer receipt. A client of the outer gateway cannot ask for those claims, and
cannot see which inner session served it.

Measured on 2026-09-23: through RedPill, `z-ai/glm-5.3-flash` was served via
NEAR's router (GPU and weights unknown, TCB refuted), while `z-ai/glm-5.3` could
be pinned to a Phala-direct session with GPU, TCB and OS claims. The outer
receipt looked the same in both cases.

ACI §5.3 scopes `provider.aci_session_ids` to the service's own sessions, and
the gateway strips the member before forwarding. That is right for one hop. It
leaves nested services without a way to pass a requirement down.

## Proposal

### 1. Required claims on an `aci-service` upstream

A new optional field on the upstream entry:

```json
{ "name": "redpill", "provider": "aci-service", "base_url": "https://api.redpill.ai",
  "required_upstream_claims": ["tee_attested=hardware_proven", "tcb_up_to_date=hardware_proven",
                               "gpu_attested", "os_known_good"] }
```

Before forwarding, the backend picks the inner service's current sessions for
the model that meet the required claims, the same audit `pap sessions
--require-claim` runs. It then sets `provider.aci_verified: true` and
`provider.aci_session_ids` on the upstream request. The inner service enforces
its own sessions under its own §5.3 rules. If none qualify, the request fails
closed with `no_eligible_attested_route`.

Session lists rotate, so the choice is cached briefly and refreshed on
`session_not_accepted` (412), as `pap serve --require-claim` already does.

### 2. The inner receipt in the outer receipt

A new receipt event, emitted when an `aci-service` upstream returns
`x-receipt-id`:

```json
{ "type": "upstream.receipt", "upstream": "redpill",
  "receipt_id": "rcpt-…", "session_ids": ["<inner session ids that were allowed>"] }
```

A verifier fetches the inner receipt, verifies it against the inner service's
keyset (already established by the outer session's evidence), and checks the
session it cites. That gives an unbroken chain: outer receipt, outer session
(inner gateway identity), inner receipt, inner session (model VM claims).

### 3. Verifier support

`pap audit` and `pap send` follow `upstream.receipt` one level and report the
inner claims, with a `--require-upstream-claim` flag.

## Why this belongs upstream

Any operator that composes ACI services has this gap, not just envolvr. The
change fits the existing model: constraints only tighten, pins stay scoped to
the service that owns the sessions, and every hop is verified by its own
evidence.

envolvr can contribute the implementation for items 1 and 2.
