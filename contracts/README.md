# contracts

`GroupTreasury.sol`: one deployment for every group chat, on **Arc testnet** (chain id 5042002).
Each chat is a group keyed by `keccak256("chat:" + chatId)`; membership and limits are per group,
so people can be in several chats with a different limit in each, and chats gain and lose members.
Arc uses USDC as gas, and the contract moves USDC through its ERC-20 interface at
`0x3600000000000000000000000000000000000000` (6 decimals).

## What it enforces

| Rule | How |
| --- | --- |
| Money stays in members' wallets | Each person approves the contract on USDC once (covers all their groups); shares are pulled with `transferFrom` only at settle time |
| Members come and go | A person joins a group from their own wallet (`join`) the first time they talk in that chat. Someone who leaves the chat is removed by the agent (`removeMember`), or leaves themselves (`leave`) |
| Recurring limits, per group | `join(group, limit, period)` / `setLimit` from the member's own wallet. Weekly windows start Monday 00:00 UTC; monthly windows are fixed 30 days |
| Limits set in the chat | "Lower my limit" → the agent calls `lowerLimit` (operator can only lower). "Raise my limit" → a `setLimit` transaction from the member's own wallet |
| Everyone in a split approves | The agent `propose`s a split; each participant `approve`s from their own wallet (the onchain twin of 👍). `settle` reverts until all have approved |
| Shares go only to the payer | `settle` pulls each share to the proposal's payee; anyone may call it once approved |
| Over-limit or failed pulls | Recorded in `debts[debtor][creditor]` instead of reverting; `payDebt` clears them |

The operator (the agent's key) can propose, cancel, lower limits and remove members, which all only
reduce what can be pulled. It cannot raise a limit, add a member, approve on a member's behalf, or
settle an unapproved split, so a prompt-injected agent can't move money.

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
| Arc testnet | [`0xe1828Ca092Cb12663ae8610d16c144E388F8e876`](https://testnet.arcscan.app/address/0xe1828Ca092Cb12663ae8610d16c144E388F8e876) (operator `0xDEbAA02AAB62BDc01dddd5830D3a0D613C80842f`) |
