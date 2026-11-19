# contracts

`GroupTreasury.sol`: one deployment for every group chat, on **Arc testnet** (chain id 5042002).
Each chat is a group keyed by `keccak256("chat:" + chatId)`; membership and limits are per group,
so people can be in several chats with a different limit in each, and chats gain and lose members.
Arc uses USDC as gas, and the contract moves USDC through its ERC-20 interface at
`0x3600000000000000000000000000000000000000` (6 decimals).

## Onboarding (Face ID link)

1. The agent is in a group chat and posts "reply 'in' to join".
2. It DMs each person who replies a link with a single-use **ticket** for that chat.
3. The link opens a static page: Face ID creates the member's Circle passkey wallet (or logs in to
   it), they pick their limit for this chat, and one gasless batched transaction approves USDC
   for this contract and calls `join(group, limit, period, ticket)`.
4. The server watches `Joined` events, matches the ticket to the person's handle, and records
   their wallet. Holding the DMed link is the proof of identity; the page needs no backend.

## What it enforces

| Rule | How |
| --- | --- |
| Money stays in members' wallets | Each person approves the contract on USDC once (covers all their groups); shares are pulled with `transferFrom` only at settle time |
| One wallet per person, a limit per chat | Groups are keyed by `keccak256("chat:" + chatId)`; `members[group][wallet]` holds that chat's limit |
| Members sign their own limits | `join` and `setLimit` come from the member's passkey wallet (Face ID). Raising a limit is a Face ID link |
| Invite links can't be replayed | Each `ticket` can be used once |
| 👍 needs no Face ID | The agent relays a 👍 with `approveFor`; `settle` reverts until every participant has approved |
| The agent can only reduce exposure | Operator-only `lowerLimit` (can't raise) and `removeMember` (someone left the chat) |
| No pull beyond the signed limit | `settle` pulls each share to the payee only while it fits what's left of that member's limit in that group (weekly windows from Monday 00:00 UTC; monthly = 30 days) |
| Over-limit or failed pulls | Recorded in `debts[debtor][creditor]` instead of reverting; `payDebt` clears them |

The operator (the agent's key) can propose and cancel splits, relay 👍s, lower limits and remove
members. It cannot add members, raise a limit or send money anywhere but a split's payee, and a
fuzz test checks that it can never take more from a member than the limit they signed.

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
| Arc testnet | [`0x1E383fe0098f3dE2530b42f1c8172CA2BC547320`](https://testnet.arcscan.app/address/0x1E383fe0098f3dE2530b42f1c8172CA2BC547320) (operator `0xDEbAA02AAB62BDc01dddd5830D3a0D613C80842f`) |
