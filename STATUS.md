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
| **Decide:** chain (Arc / Base / other) | 🔲 decision | ask Siya before choosing |
| **Decide:** wallet provider + limit enforcement | 🔲 decision | onchain spend permissions vs provider policy vs permits |
| **Decide:** funding provider | 🔲 decision | |
| **Decide:** optional onchain components | 🔲 decision | mandates, cart/receipt fingerprints, ledger/netting, track record, escrow |

## Track B — Agent, chat & commerce

Owns: `packages/imessage`, `packages/agent`, `packages/purchase`.

| Task | Status | Notes |
| --- | --- | --- |
| `PhotonChatPort` — post, image, 👍 reactions, DM | ⬜ todo | real `@photon-ai/imessage-kit`; needs a Mac + Full Disk Access |
| `agent` — parse requests → intents | ⬜ todo | Claude + Vercel AI SDK (`generateObject`) |
| `agent` — read receipts → `Receipt` (pay-after) | ⬜ todo | `ReceiptReader` impl (Claude vision via AI SDK) |
| `agent` — drive the state machine via ports | ⬜ todo | perform effects: post_preview, place_order, pull_shares |
| `PurchaseAdapter` — **real** store checkout (Crossmint) | ⬜ todo | DEMO-CRITICAL. Crossmint Agent Checkouts API; real checkout, not mocked. |
| ✅ **Decided:** LLM + framework | ✅ done | **Claude + Vercel AI SDK**, default model **Sonnet 5** (swappable). Needs Anthropic API key (not the Claude subscription). |
| ✅ **Decided:** store + access method | ✅ done | **Crossmint** Agent Checkouts (universal catalog, buyer's own account via Browser Profiles). agent-browser kept as a swappable fallback behind `PurchaseAdapter`. |

## Shared — coordinate before touching

| Task | Status | Notes |
| --- | --- | --- |
| `packages/core` — interfaces | ✅ done | frozen contract between tracks; change together only |
| `apps/server` — wire real adapters | ⬜ todo | do **together, last**, once both sides are real |
| **Decide:** project name | 🔲 decision | currently `@gta/*` placeholder scope |

**Legend:** ✅ done · 🟡 in progress · ⬜ todo · 🔲 decision needed
