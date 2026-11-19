# Who's doing what

Two people, two vertical tracks. Each track implements a different set of the
interfaces (ports) defined in `packages/core`, so the two sides can be built and
tested independently — each against the other side's stub.

## Owners

| Track | Person | GitHub |
| --- | --- | --- |
| **A — Money & onchain** | Neena | `@neenanaikar` |
| **B — Agent, chat & commerce** | Siya | `@siyasiyasiya` |

## Git workflow

Both push directly to `main`. To keep that collision-free:

```bash
git config pull.rebase true   # one-time, per clone — pull rebases instead of merging
# normal loop:
git pull            # rebases your local work on top of main
# ...work...
git add -A && git commit -m "..." && git push
```

Pull before you start and before you push. Keep commits small so rebases are trivial.

---

## Critical path to the demo (deadline Fri Nov 20, 12:00 PM CST)

The pieces work on their own; the demo needs them joined up. In order:

| # | What | Owner | Status | Blocks |
| --- | --- | --- | --- | --- |
| 1 | Merge Track A: contract, Face ID page, Arc Onramp, `ArcWalletAdapter` | Neena | ✅ merged (#7, included #3) | — |
| 2 | DMs in `PhotonChatPort` | Siya | ✅ done (97109f4, imessage-kit `send({ to: handle })`) | 3 |
| 3 | "in" → invite ticket → DM the Face ID link | Neena | 🟡 built (5fdb335, `send_join_link` tool, DM with group fallback); live test pending | demo |
| 4 | Watch `Joined` events → link wallet to handle (`Member.wallet`) → fund new account (testnet) | Neena | ✅ done, live: Siya, Tristan, Joey joined Nov 18 | — |
| 5 | Runtime picks the wallet adapter per chat | shared | ✅ done (#9) | — |
| 6 | Pay-after flow live on Arc | shared | ✅ ran live Nov 18: card → 👍 → settle onchain. Joey's $10 share failed (only $5 in his account) and became an onchain debt, so we need step 9 | — |
| 7 | README for judges: architecture, Arc + Circle usage, contract address, how to run | both | 🟡 "How Arc and Circle are used" section done | submission |
| 8 | Demo script + dry run on real phones | both | ⬜ todo | submission |
| 9 | Short balance: DM a top-up + "pay it back" link, Face ID `payDebt`, "✅ paid back" in chat | Neena | 🟡 built (5fdb335 server, 7652da2 page `?r=`); page not deployed yet, live test pending | demo |
| 10 | Limit changes from chat: lower → operator `lowerLimit` now; raise → DM Face ID link | Neena | 🟡 built (5fdb335; page prefills `?l=&p=`); live test pending | demo |
| 11 | 👍 tapbacks on the card (local mode) | Siya | ✅ done (97109f4, reads `chat.db`); live test pending | demo |
| 13 | One-tap Face ID page: amount decided in chat rides in the link, no form; iMessage link card (og.png) | Neena | 🟡 deployed Nov 18 (70d4f3d); phone test pending | demo |
| 12 | Neena's own messages: bot runs on her Apple ID, so it ignores her | Neena | 🔲 decide: `SELF_HANDLE` (built, off) or a separate Apple ID for the bot | demo |

---

## Track A — Money & onchain

Owns: `contracts/`, `packages/wallet`, `packages/funding`, `apps/onboard`.

| Task | Status | Notes |
| --- | --- | --- |
| `GroupTreasury.sol` + Foundry tests | ✅ done | One deployment for every chat; per-chat members + limits; single-use join tickets; operator relays 👍 (`approveFor`) but can only lower limits / remove members; failed pulls become debts. 49 tests incl. fuzz "operator can't take more than the signed limit". **Arc testnet: `0xDC349427bE00454800D17a7FB7f7946CA5884F98`** |
| Face ID onboarding page (`apps/onboard`) | ✅ done | **https://kittyagent.vercel.app** — Circle passkey wallet + one gasless batched op (approve USDC + `join`). Tested on a real iPhone. First join = 2 Face ID prompts, later visits = 1. No crypto words shown. |
| `WalletAdapter` — in-memory dev impl | ✅ done (on main) | `InMemoryWalletAdapter`, weekly/monthly limits, idempotent pulls. Non-production. |
| `WalletAdapter` — real impl (Arc) | ✅ done | `ArcWalletAdapter`: each pull = one-person split (`propose` → `approveFor` → `settle`), idempotent across restarts, over-limit → onchain debt. Anvil tests + live read on Arc. Full live pull waits on a member joining via the page. |
| Funding — add money (Arc Onramp) | 🟡 built, untested on phone | `/api/onramp-session` on Vercel mints an Arc Onramp **sandbox** session delivering USDC straight to the member's account (Kitty never holds funds). Page shows balance + "Add money with Apple Pay"; `?a=<account>` top-up link for "you're short" DMs. **To do:** test on a phone and confirm sandbox USDC lands on Arc testnet. Production needs Circle KYB with our domain. |
| Invite tickets + DM link | 🟡 built | Tickets, links, invite CLI, and the `send_join_link` agent tool (DMs the link; group post if the DM fails). The member list tells the agent who isn't set up. |
| `Joined` watcher → handle ↔ wallet | ✅ done, live | `JoinWatcher` polls in ≤2,000-block windows, matches ticket → handle, posts "✅ X is in", sends a testnet welcome balance ($5 from the operator; Circle faucet API is 403 for our key). |
| Limit changes from chat | 🟡 built | Lower → operator `lowerLimit` right away. Raise or switch period → DM a Face ID link (`?g=&c=&l=&p=`, prefilled) → member's `setLimit` → watcher posts "✅ X updated their limit" (no amount). |
| Short balance → top-up + pay back | 🟡 built | A failed share reads "not enough in their Kitty account" / "over their limit" and DMs a pay-back link (`?r=<payee>&o=<name>`): add money, then Face ID `payDebt`. Watcher posts "✅ X paid Y back $N". Page change needs a Vercel deploy. |
| ✅ **Decided:** chain | ✅ | **Arc testnet** — USDC is gas, ~1s finality, Circle passkey wallets + paymaster. |
| ✅ **Decided:** wallets + limit enforcement | ✅ | **Circle passkey (modular) wallets**, one per person; **limits enforced by `GroupTreasury`**, one per chat, signed by the member with Face ID. 👍 relayed by the agent, capped by that limit. |
| ✅ **Decided:** funding | ✅ | **Arc Onramp** (Apple Pay / debit → USDC on Arc, delivered to the member). Fallbacks: Coinbase Onramp or Crossmint → Base, then CCTP to Arc. |
| ✅ **Decided:** optional onchain components | ✅ | Built: per-chat spending limits (mandates) + debt ledger. Skipped for now: cart/receipt fingerprints, escrow, agent track record. |

## Track B — Agent, chat & commerce

Owns: `packages/imessage`, `packages/agent`, `packages/purchase`.

| Task | Status | Notes |
| --- | --- | --- |
| `PhotonChatPort` — post, image, 👍 reactions | ✅ done | Switched to **imessage-kit** (97109f4): spectrum-ts local mode drops every tapback. Group 👍 senders are read from `chat.db`. Posting to a chat no longer needs an inbound message first (a38bb07). |
| `PhotonChatPort` — **DMs** | ✅ done | `sendDirectMessage` sends to the bare handle. |
| `agent` — parse requests → intents + `runTurn` | ✅ done | **Claude via Anthropic SDK** tool-runner (`runTurn`); model `claude-sonnet-5`. |
| `agent` — read receipts → `Receipt` (pay-after) | ✅ done | `ClaudeReceiptReader` (Claude vision). |
| `agent` — drive the state machine via ports | ✅ done | `apps/server` runtime + sim orchestration (pay-after flow); 5 runtime tests. |
| `agent` — join + limit tools | ⬜ todo | "in" → hand off to the invite flow; `set_my_limit` → lower onchain / send Face ID link to raise. |
| `agent` — no crypto words in chat | ⬜ todo | Members see "your Kitty account", "$50", "Face ID" — never wallet, USDC, transaction, Arc, onchain, gas, passkey. |
| `PurchaseAdapter` — **real** store checkout (Crossmint) | ✅ done | Crossmint Agent Checkouts REST; real (not mocked); 14 tests; `blocked` handled. Needs CROSSMINT creds to run live. |
| ✅ **Decided:** LLM + framework | ✅ done | **Claude + raw Anthropic SDK** (no web UI → dropped Vercel AI SDK), model **Sonnet 5**. Needs Anthropic API key (not the Claude subscription). |
| ✅ **Decided:** iMessage SDK | ✅ done | **imessage-kit** (local; reads `chat.db`). spectrum-ts local mode drops tapbacks and has no DMs — so it couldn't do 👍 approvals or onboarding DMs. Switched in 97109f4. |
| ✅ **Decided:** store + access method | ✅ done | **Crossmint** Agent Checkouts (universal catalog, buyer's own account via Browser Profiles). agent-browser kept as a swappable fallback behind `PurchaseAdapter`. |

## Shared — coordinate before touching

| Task | Status | Notes |
| --- | --- | --- |
| `packages/core` — interfaces | ✅ done | frozen contract between tracks; change together only |
| `apps/server` — wire real adapters | 🟡 pay-after live on Arc | Per-chat `ArcWalletAdapter`, wallets from `Joined`, live in a real group. To do: pay-before (purchase) wiring. |
| Open PRs to sort out | 🟡 | #3 + #7 merged. Superseded by main, safe to close: #1 (workflow, c6d610d), #5 (wallet + 👍 rule, f8f014a/12487c5), #6 (`model.ts` no longer exists). #4 (imessage-kit 👍 resolver) superseded by the imessage-kit switch (97109f4), safe to close. |
| README for judges | ⬜ todo | Architecture, how Arc + Circle (passkeys, paymaster, Onramp) are used, contract address, why onchain. Draft explainer: onboarding + "why onchain" page (Neena has the link). |
| **Decide:** project name | 🟡 working name | **Kitty**, page at `kittyagent.vercel.app`. Passkeys are tied to the domain, so pick the final domain before real users join. Package scope still `@gta/*`. |

## Ops notes

- **Secrets:** `contracts/.env` (gitignored): Arc RPC, operator key, treasury address, `CIRCLE_API_KEY`, `CIRCLE_CLIENT_KEY`. Vercel project `kittyagent` holds `CIRCLE_API_KEY` (secret), `VITE_CLIENT_KEY`, `VITE_TREASURY_ADDRESS`. ⚠️ Rotate the Circle API key (it was exposed in a session log).
- **Operator wallet** `0xDEbAA02AAB62BDc01dddd5830D3a0D613C80842f` pays gas and $5 welcome balances; ~21.8 test USDC on Nov 18 (each join costs $5). Top up at faucet.circle.com (Arc Testnet).
- **Vercel deploys** run from a copy of `apps/onboard` outside git, because the git commit email isn't on the Vercel team. Add it to the team (or connect the repo) to deploy from git.

**Legend:** ✅ done · 🟡 in progress · ⬜ todo · 🔲 decision needed
