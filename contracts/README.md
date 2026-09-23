# envolvr contracts

| Contract | Purpose |
|---|---|
| `ReceiptAnchor` | Append-only log of receipt batch Merkle roots, one chain per provider. `verifyReceipt` proves a receipt's inclusion. |
| `WeightsRegistry` | Write-once reference weights roots per model repository and revision, for attested weights. |
| `EnvolvrToken` | Fixed-supply ERC-20 with permit. No owner, no mint. |
| `StakingAllowance` | Stake ENVOLVR for a pro-rata share of a capped daily inference budget, snapshotted at 00:00 UTC. Fixed unstake cooldown and budget notice. |
| `CreditVault` | USDG deposits that credit a wallet's prepaid inference balance. Supports deposits on behalf of another wallet and EIP-2612 permit. |
| `testnet/MockUSDG` | Testnet only: 6-decimal stand-in for USDG with an open mint. |

```bash
forge test
forge script script/Deploy.s.sol --rpc-url robinhood_testnet --broadcast --private-key $DEPLOYER_PRIVATE_KEY
```

Deploy scripts: `Deploy` (ReceiptAnchor, WeightsRegistry), `DeployStaking`
(EnvolvrToken, StakingAllowance), `DeployVault` (CreditVault, with MockUSDG when
`USDG` is unset). Testnet addresses are in `deployments/robinhood-testnet.json`.
