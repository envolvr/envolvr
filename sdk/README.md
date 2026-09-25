# @envolvr/sdk

Private inference your agent can prove. The envolvr gateway runs in an attested
Intel TDX enclave and speaks the OpenAI API; every response comes with a signed
receipt that records the model, the attested provider session, commitments to
the request and response, and what was billed. Receipt hashes are anchored on
Robinhood Chain every 10 minutes. This package signs in with a wallet, funds
the account with USDG, runs inference, keeps every receipt, and verifies it.

```bash
npm install @envolvr/sdk        # Node 20+
```

## From zero to a verified receipt (testnet)

```bash
export ENVOLVR_PRIVATE_KEY=0x…   # a wallet with a little Robinhood testnet ETH for gas
npx envolvr signin --save        # sign a message, get an API key
npx envolvr testnet-mint 20      # test USDG (testnet only)
npx envolvr deposit 10           # credited net of the deposit fee, within seconds
npx envolvr chat "Reply with the single word: sealed"
npx envolvr verify --last        # signature, billing, payer, on-chain anchor
```

`verify` prints what the receipt proves: the gateway's TDX attestation and the
receipt signature (checked by `private-ai-proxy`), what was billed and that it
was billed to your key, and the batch and transaction that anchor it. A receipt
is anchored at the end of its 10-minute slot (UTC).

## In code

```ts
import { Envolvr, privateKeySigner, signIn, depositUsdg, TESTNET, toMicros } from '@envolvr/sdk';

const wallet = privateKeySigner(process.env.KEY!, { rpcUrl: TESTNET.rpcUrl, chainId: TESTNET.chainId });
const { apiKey } = await signIn(wallet);                          // keep it: shown once
await depositUsdg({ signer: wallet, amountMicros: toMicros('10') });

const envolvr = new Envolvr({ apiKey, receiptDir: './receipts' });
const { response, saved } = await envolvr.chat({
  model: 'z-ai/glm-5.3',
  messages: [{ role: 'user', content: 'hello' }],
  provider: { only: ['redpill'] },                                // optional: pin providers
});
const proof = await envolvr.verify(saved!.dir!);                  // after the slot closes
```

Using the OpenAI SDK instead: `new OpenAI(envolvr.openai)`. Then fetch each
receipt yourself with `envolvr.receipt(id)` within an hour: the gateway keeps
receipts for an hour. For an OpenAI client that verifies the service before
sending and checks every receipt, run the local verifying proxy
`npx private-ai-proxy serve https://api.envolvr.xyz` and point the client at
`http://127.0.0.1:4180/v1`.

Any wallet works for sign-in and deposits: implement `Signer` (`address`,
`signMessage`, and `sendTransaction` for deposits) around viem, ethers or a
hardware wallet.

## Pricing

Per-token prices are the providers' own list prices (`envolvr models`). A fee
is kept from each USDG deposit (`envolvr pricing`). Every receipt records the
token counts, the rates and the amount billed, so any charge can be recomputed.
If a request allows several providers, it is priced at the highest of their
list prices.
