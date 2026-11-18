# contracts

Chain-agnostic EVM group contract (Foundry).

**Planned:** `GroupTreasury.sol` — members, pulling each member's share to the
payer within their limit, and recording what each member owes when a pull
fails. Chain and whether to build the optional onchain components (mandates,
cart/receipt fingerprints, ledger/netting, track record, escrow) are undecided.

```bash
forge build
forge test
```
