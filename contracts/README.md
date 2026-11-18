# contracts

`GroupTreasury.sol`: one contract per group chat, deployed on **Arc testnet** (chain id 5042002).
Arc uses USDC as gas, and the contract moves USDC through its ERC-20 interface at
`0x3600000000000000000000000000000000000000` (6 decimals).

## What it enforces

| Rule | How |
| --- | --- |
| Money stays in members' wallets | Each member approves the contract on USDC once; shares are pulled with `transferFrom` only at settle time |
| Recurring limits | `join(limit, period)` / `setLimit` from the member's own wallet. Weekly windows start Monday 00:00 UTC; monthly windows are fixed 30 days |
| Limits set in the chat | "Lower my limit" → the agent calls `lowerLimit` (operator can only lower). "Raise my limit" → a `setLimit` transaction from the member's own wallet |
| Everyone in a split approves | The agent `propose`s a split; each participant `approve`s from their own wallet (the onchain twin of 👍). `settle` reverts until all have approved |
| Shares go only to the payer | `settle` pulls each share to the proposal's payee; anyone may call it once approved |
| Over-limit or failed pulls | Recorded in `debts[debtor][creditor]` instead of reverting; `payDebt` clears them |

The operator (the agent's key) can propose, cancel and lower limits. It cannot raise a limit, approve
on a member's behalf, or settle an unapproved split, so a prompt-injected agent can't move money.

## Use

```bash
forge build
forge test
forge fmt

# deploy (needs ARC_RPC_URL, OPERATOR_ADDRESS, DEPLOYER_PRIVATE_KEY; copy .env.example to .env)
forge script script/Deploy.s.sol --rpc-url arc_testnet --broadcast --private-key $DEPLOYER_PRIVATE_KEY
```

Get testnet USDC (gas + balances) from the [Circle faucet](https://faucet.circle.com).

## Deployments

| Network | Address |
| --- | --- |
| Arc testnet | _not deployed yet_ |
