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

## Track A — Money & onchain

Owns: `contracts/`, `packages/wallet`, `packages/funding`.

| Task | Status | Notes |
| --- | --- | --- |
| `GroupTreasury.sol` + Foundry tests | ✅ done | one contract for every chat, per-chat limits, relayed 👍, debts. Deployed on Arc testnet (see `contracts/README.md`). |
| `WalletAdapter` — in-memory dev impl | ✅ done | `InMemoryWalletAdapter`, used by the server and simulator. |
| `WalletAdapter` — real impl | ✅ done | `ArcWalletAdapter`: each pull is a one-person split (propose → approveFor → settle), idempotent across restarts. Tested against the real contract on anvil. One instance per chat via `arcWalletAdapters(env)(chatId)`. |
| `funding` — card→USDC / connect wallet | 🟡 in progress | Apple Pay through Arc Onramp on the Face ID onboarding page (`apps/onboard`). |
| ✅ **Decided:** chain | ✅ done | **Arc** testnet. |
| ✅ **Decided:** wallet provider + limit enforcement | ✅ done | **Circle passkey wallets**; limits enforced onchain by `GroupTreasury`. |
| ✅ **Decided:** funding provider | ✅ done | **Arc Onramp** (Apple Pay). |
| **Decide:** optional onchain components | 🔲 decision | mandates, cart/receipt fingerprints, ledger/netting, track record, escrow |

## Track B — Agent, chat & commerce

Owns: `packages/imessage`, `packages/agent`, `packages/purchase`.

| Task | Status | Notes |
| --- | --- | --- |
| `PhotonChatPort` — post, image, 👍 reactions, DM | ✅ done | real `@photon-ai/imessage-kit` v3; 19 tests. Needs a Mac + Full Disk Access to run live. |
| `agent` — parse requests → intents | ✅ done | Claude + Vercel AI SDK (`generateObject`); swappable/injectable model. |
| `agent` — read receipts → `Receipt` (pay-after) | ✅ done | `ClaudeReceiptReader` (Claude vision via AI SDK). |
| `agent` — drive the state machine via ports | ⬜ todo | server wiring (shared, do last): perform effects post_preview, place_order, pull_shares. |
| `PurchaseAdapter` — **real** store checkout (Crossmint) | ✅ done | Crossmint Agent Checkouts REST; real (not mocked); 14 tests; `blocked` handled. Needs CROSSMINT creds to run live. |
| ✅ **Decided:** LLM + framework | ✅ done | **Claude + Vercel AI SDK**, default model **Sonnet 5** (swappable). Needs Anthropic API key (not the Claude subscription). |
| ✅ **Decided:** store + access method | ✅ done | **Crossmint** Agent Checkouts (universal catalog, buyer's own account via Browser Profiles). agent-browser kept as a swappable fallback behind `PurchaseAdapter`. |

## Shared — coordinate before touching

| Task | Status | Notes |
| --- | --- | --- |
| `packages/core` — interfaces | ✅ done | frozen contract between tracks; change together only |
| `apps/server` — wire real adapters | ⬜ todo | do **together, last**. Wallet side is ready: swap `InMemoryWalletAdapter` for `arcWalletAdapters(...)(chatId)`; needs `ARC_RPC_URL`, `OPERATOR_PRIVATE_KEY`, `TREASURY_ADDRESS`, plus mapping each member's handle to the wallet from the `Joined` event. |
| **Decide:** project name | 🔲 decision | currently `@gta/*` placeholder scope |

**Legend:** ✅ done · 🟡 in progress · ⬜ todo · 🔲 decision needed
