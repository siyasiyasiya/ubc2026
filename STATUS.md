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
| 1 | Merge Track A: PR #3 (contract + Face ID page), then PR #7 (Arc wallet adapter, includes #3) | Neena | 🟡 in review | 4, 6 |
| 2 | DMs in `PhotonChatPort` (`sendDirectMessage` throws today) | Siya | ⬜ todo | 3 |
| 3 | "in" → invite ticket → DM the Face ID link | Neena (runtime hook from Siya) | ⬜ todo | 4 |
| 4 | Watch `Joined` events → link wallet to handle (`Member.wallet`) → fund new account (testnet) | Neena | ⬜ todo | 6 |
| 5 | Runtime picks the wallet adapter per chat (`RuntimeDeps.wallet` is one adapter today) | shared | ⬜ todo | 6 |
| 6 | Swap `InMemoryWalletAdapter` for `arcWalletAdapters(...)(chatId)` and run the pay-after flow live | shared | ⬜ todo | demo |
| 7 | README for judges: architecture, Arc + Circle usage, contract address, how to run | both | ⬜ todo | submission |
| 8 | Demo script + dry run on real phones | both | ⬜ todo | submission |

---

## Track A — Money & onchain

Owns: `contracts/`, `packages/wallet`, `packages/funding`, `apps/onboard`.

| Task | Status | Notes |
| --- | --- | --- |
| `GroupTreasury.sol` + Foundry tests | ✅ done (PR #3) | One deployment for every chat; per-chat members + limits; single-use join tickets; operator relays 👍 (`approveFor`) but can only lower limits / remove members; failed pulls become debts. 49 tests incl. fuzz "operator can't take more than the signed limit". **Arc testnet: `0xDC349427bE00454800D17a7FB7f7946CA5884F98`** |
| Face ID onboarding page (`apps/onboard`) | ✅ done (PR #3) | **https://kittyagent.vercel.app** — Circle passkey wallet + one gasless batched op (approve USDC + `join`). Tested on a real iPhone. First join = 2 Face ID prompts, later visits = 1. No crypto words shown. |
| `WalletAdapter` — in-memory dev impl | ✅ done (on main) | `InMemoryWalletAdapter`, weekly/monthly limits, idempotent pulls. Non-production. |
| `WalletAdapter` — real impl (Arc) | 🟡 in review (PR #7) | `ArcWalletAdapter`: each pull = one-person split (`propose` → `approveFor` → `settle`), idempotent across restarts, over-limit → onchain debt. Anvil tests + live read on Arc. Full live pull waits on a member joining via the page. |
| Funding — add money (Arc Onramp) | 🟡 built, untested on phone | `/api/onramp-session` on Vercel mints an Arc Onramp **sandbox** session delivering USDC straight to the member's account (Kitty never holds funds). Page shows balance + "Add money with Apple Pay"; `?a=<account>` top-up link for "you're short" DMs. **To do:** test on a phone and confirm sandbox USDC lands on Arc testnet. Production needs Circle KYB with our domain. |
| Invite tickets + DM link | ⬜ todo | Server creates ticket for (handle, chat), DMs `kittyagent.vercel.app/?g=&t=&c=&n=`. Needs Track B DMs. |
| `Joined` watcher → handle ↔ wallet | ⬜ todo | Poll `Joined(group, member, limit, period, ticket)` in ≤2,000-block chunks (public Arc RPC rate-limits), match ticket → handle, set `Member.wallet`, fund with faucet (`CIRCLE_API_KEY`). |
| Limit changes from chat | ⬜ todo | "Lower my limit" → operator `lowerLimit`. "Raise my limit" → DM a Face ID link (`?g=&c=`, no ticket) → member's `setLimit`. Needs the agent's `set_my_limit` tool to route this way. |
| "You're short" top-up DM | ⬜ todo | When a share fails for low balance, DM `kittyagent.vercel.app/?a=<account>&c=<chat>`. |
| ✅ **Decided:** chain | ✅ | **Arc testnet** — USDC is gas, ~1s finality, Circle passkey wallets + paymaster. |
| ✅ **Decided:** wallets + limit enforcement | ✅ | **Circle passkey (modular) wallets**, one per person; **limits enforced by `GroupTreasury`**, one per chat, signed by the member with Face ID. 👍 relayed by the agent, capped by that limit. |
| ✅ **Decided:** funding | ✅ | **Arc Onramp** (Apple Pay / debit → USDC on Arc, delivered to the member). Fallbacks: Coinbase Onramp or Crossmint → Base, then CCTP to Arc. |
| ✅ **Decided:** optional onchain components | ✅ | Built: per-chat spending limits (mandates) + debt ledger. Skipped for now: cart/receipt fingerprints, escrow, agent track record. |

## Track B — Agent, chat & commerce

Owns: `packages/imessage`, `packages/agent`, `packages/purchase`.

| Task | Status | Notes |
| --- | --- | --- |
| `PhotonChatPort` — post, image, 👍 reactions | ✅ done | **spectrum-ts**; attributed 👍 via `message.sender`; 15 tests. ⚠️ Local group-reaction delivery still to verify on a Mac — if it doesn't, port PR #4's `chat.db` sender-resolver (imessage-kit) as fallback. |
| `PhotonChatPort` — **DMs** | ⬜ todo | `sendDirectMessage` throws. **Blocks Track A onboarding** (the Face ID link is sent by DM). |
| `agent` — parse requests → intents + `runTurn` | ✅ done | **Claude via Anthropic SDK** tool-runner (`runTurn`); model `claude-sonnet-5`. |
| `agent` — read receipts → `Receipt` (pay-after) | ✅ done | `ClaudeReceiptReader` (Claude vision). |
| `agent` — drive the state machine via ports | ✅ done | `apps/server` runtime + sim orchestration (pay-after flow); 5 runtime tests. |
| `agent` — join + limit tools | ⬜ todo | "in" → hand off to the invite flow; `set_my_limit` → lower onchain / send Face ID link to raise. |
| `agent` — no crypto words in chat | ⬜ todo | Members see "your Kitty account", "$50", "Face ID" — never wallet, USDC, transaction, Arc, onchain, gas, passkey. |
| `PurchaseAdapter` — **real** store checkout (Crossmint) | ✅ done | Crossmint Agent Checkouts REST; real (not mocked); 14 tests; `blocked` handled. Needs CROSSMINT creds to run live. |
| ✅ **Decided:** LLM + framework | ✅ done | **Claude + raw Anthropic SDK** (no web UI → dropped Vercel AI SDK), model **Sonnet 5**. Needs Anthropic API key (not the Claude subscription). |
| ✅ **Decided:** iMessage SDK | ✅ done | **spectrum-ts** (Photon's current SDK). imessage-kit + PR #4 kept as a proven fallback for group-reaction attribution. |
| ✅ **Decided:** store + access method | ✅ done | **Crossmint** Agent Checkouts (universal catalog, buyer's own account via Browser Profiles). agent-browser kept as a swappable fallback behind `PurchaseAdapter`. |

## Shared — coordinate before touching

| Task | Status | Notes |
| --- | --- | --- |
| `packages/core` — interfaces | ✅ done | frozen contract between tracks; change together only |
| `apps/server` — wire real adapters | 🟡 pay-after done | Pay-after runs on the in-memory wallet. To do: per-chat Arc adapter, member wallets from `Joined`, pay-before (purchase) wiring. |
| Open PRs to sort out | 🟡 | #3 + #7 Track A (merge #7, it contains #3). #4 / #5 / #6: check whether main's reconcile already covers them, then merge or close. #1 team workflow. |
| README for judges | ⬜ todo | Architecture, how Arc + Circle (passkeys, paymaster, Onramp) are used, contract address, why onchain. Draft explainer: onboarding + "why onchain" page (Neena has the link). |
| **Decide:** project name | 🟡 working name | **Kitty**, page at `kittyagent.vercel.app`. Passkeys are tied to the domain, so pick the final domain before real users join. Package scope still `@gta/*`. |

## Ops notes

- **Secrets:** `contracts/.env` (gitignored): Arc RPC, operator key, treasury address, `CIRCLE_API_KEY`, `CIRCLE_CLIENT_KEY`. Vercel project `kittyagent` holds `CIRCLE_API_KEY` (secret), `VITE_CLIENT_KEY`, `VITE_TREASURY_ADDRESS`. ⚠️ Rotate the Circle API key (it was exposed in a session log).
- **Operator wallet** `0xDEbAA02AAB62BDc01dddd5830D3a0D613C80842f` pays gas for proposals/settles; ~19.8 test USDC left. Top up at faucet.circle.com (Arc Testnet).
- **Vercel deploys** run from a copy of `apps/onboard` outside git, because the git commit email isn't on the Vercel team. Add it to the team (or connect the repo) to deploy from git.

**Legend:** ✅ done · 🟡 in progress · ⬜ todo · 🔲 decision needed
