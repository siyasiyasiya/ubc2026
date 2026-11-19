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
| `GroupTreasury.sol` + Foundry tests | ⬜ todo | members, pull each share to payer, record debt on failed pull. Chain-agnostic EVM. |
| `WalletAdapter` — in-memory dev impl | ⬜ todo | lets the server/state machine run with no chain. Label non-production. |
| `WalletAdapter` — real impl | ⬜ todo | pull share within recurring limit. Blocked on decisions below. |
| `funding` — card→USDC / connect wallet | ⬜ todo | blocked on funding provider decision. |
| ✅ **Decided:** chain | ✅ done | **Arc** (Siya approved). Contract + Face ID passkey onboarding — PR #3. |
| **Decide:** wallet provider + limit enforcement | 🔲 decision | onchain spend permissions vs provider policy vs permits |
| **Decide:** funding provider | 🔲 decision | |
| **Decide:** optional onchain components | 🔲 decision | mandates, cart/receipt fingerprints, ledger/netting, track record, escrow |

## Track B — Agent, chat & commerce

Owns: `packages/imessage`, `packages/agent`, `packages/purchase`.

| Task | Status | Notes |
| --- | --- | --- |
| `PhotonChatPort` — post, image, 👍 reactions, DM | ✅ done | **spectrum-ts**; attributed 👍 via `message.sender`; 15 tests. ⚠️ Local group-reaction delivery still to verify on a Mac — if it doesn't, port PR #4's `chat.db` sender-resolver (imessage-kit) as fallback. |
| `agent` — parse requests → intents + `runTurn` | ✅ done | **Claude via Anthropic SDK** tool-runner (`runTurn`); model `claude-sonnet-5`. |
| `agent` — read receipts → `Receipt` (pay-after) | ✅ done | `ClaudeReceiptReader` (Claude vision). |
| `agent` — drive the state machine via ports | ✅ done | `apps/server` runtime + sim orchestration (pay-after flow); 5 runtime tests. |
| `PurchaseAdapter` — **real** store checkout (Crossmint) | ✅ done | Crossmint Agent Checkouts REST; real (not mocked); 14 tests; `blocked` handled. Needs CROSSMINT creds to run live. |
| ✅ **Decided:** LLM + framework | ✅ done | **Claude + raw Anthropic SDK** (no web UI → dropped Vercel AI SDK), model **Sonnet 5**. Needs Anthropic API key (not the Claude subscription). |
| ✅ **Decided:** iMessage SDK | ✅ done | **spectrum-ts** (Photon's current SDK). imessage-kit + PR #4 kept as a proven fallback for group-reaction attribution. |
| ✅ **Decided:** store + access method | ✅ done | **Crossmint** Agent Checkouts (universal catalog, buyer's own account via Browser Profiles). agent-browser kept as a swappable fallback behind `PurchaseAdapter`. |

## Shared — coordinate before touching

| Task | Status | Notes |
| --- | --- | --- |
| `packages/core` — interfaces | ✅ done | frozen contract between tracks; change together only |
| `apps/server` — wire real adapters | 🟡 pay-after done | runtime wires chat+agent+wallet+receipts for the pay-after flow; pay-before (purchase) not wired yet. |
| **Decide:** project name | 🔲 decision | currently `@gta/*` placeholder scope |

**Legend:** ✅ done · 🟡 in progress · ⬜ todo · 🔲 decision needed
