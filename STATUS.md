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
| `WalletAdapter` — in-memory dev impl | 🟡 in review | `InMemoryWalletAdapter`: weekly/monthly limits, idempotent pulls, 5 tests. Non-production. |
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
| `PhotonChatPort` — post, image, 👍 reactions, DM | 🟡 in review | built by Neena on `spectrum-ts` local mode (wraps imessage-kit). Tested in a real group chat: text, photos, replies. Not yet confirmed: 👍 tapback format. DMs not supported yet. |
| `agent` — parse requests → intents | ⬜ todo | blocked on LLM + framework decision |
| `agent` — read receipts → `Receipt` (pay-after) | 🟡 in review | `ClaudeReceiptReader` (Claude vision + structured output, HEIC→JPEG via sips). Needs an API key to verify live. |
| `agent` — drive the state machine via ports | 🟡 in review | `GroupRuntime` in apps/server performs post_preview, pull_shares, notify for pay-after. place_order not wired (pay-before). |
| `PurchaseAdapter` — **real** store checkout | ⬜ todo | DEMO-CRITICAL. Must be a real checkout, not mocked. |
| **Decide:** LLM + agent framework | 🟡 proposed | Claude (claude-opus-5-5, low effort) via the Anthropic SDK tool runner. Siya to confirm. |
| **Decide:** first store + access method | 🔲 decision | official agent API vs browser automation |

## Shared — coordinate before touching

| Task | Status | Notes |
| --- | --- | --- |
| `packages/core` — interfaces | ✅ done | frozen contract between tracks; change together only |
| `apps/server` — wire real adapters | 🟡 in review | runtime + composition root + terminal simulator; review together |
| **Decide:** project name | 🔲 decision | currently `@gta/*` placeholder scope |

**Legend:** ✅ done · 🟡 in progress · ⬜ todo · 🔲 decision needed
