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
| 3 | "in" → invite ticket → DM the Face ID link | Neena | ✅ live: rejoin links DMed after the redeploy; links only carry the chat's plan (f6f2031) | demo |
| 4 | Watch `Joined` events → link wallet to handle (`Member.wallet`) → fund new account (testnet) | Neena | ✅ done, live: Siya, Tristan, Joey joined Nov 18 | — |
| 5 | Runtime picks the wallet adapter per chat | shared | ✅ done (#9) | — |
| 6 | Pay-after flow live on Arc | shared | ✅ live Nov 18-19 on the new contract: #1 $4 and #2 $1 settled by 👍 tapback | — |
| 7 | README for judges: architecture, Arc + Circle usage, contract address, how to run | both | ✅ updated Nov 19 (de73739): "What works today" table, real pay-before/pay-after flows, ElevenLabs section, run steps | submission |
| 8 | Demo script + dry run on real phones | both | 🟡 draft in docs/demo-script.md (with pre-flight checklist); dry run todo | submission |
| 9 | Short balance: DM a top-up + "pay it back" link, Face ID `payDebt`, "✅ paid back" in chat | Neena | 🟡 live up to the pay-back: #3 Joey's $3 failed (no balance), became a debt, pay-back DM sent. Joey funded $5 (0x4024…2482); Face ID pay-back not tapped yet | demo |
| 10 | Limit changes from chat: lower → operator `lowerLimit` now; raise → DM Face ID link | Neena | ✅ lowering live (Joey $200 → $50, block 72968628); raising: built, one-tap page live | demo |
| 11 | 👍 tapbacks on the card (local mode) | Siya | ✅ live Nov 18: Joey's tapback approved #1 and his $4 settled on Arc (0x3416…24b2). Card ids sometimes fall back to `local:…`; the runtime matches those (e9fd2f9) and Siya is fixing the guid capture | demo |
| 13 | One-tap Face ID page: amount decided in chat rides in the link, no form; iMessage link card (og.png) | Neena | ✅ live; rejoins went through it. Old join links no longer reset a limit (16a374a). Nov 19: redesigned (41782e4) and deployed: Kitty header + chat pill, limit shown as a **spending cap with its cycle** ("$50 per week · Resets every week" / "$300 one time · Doesn't reset"), quick-pick amounts, Weekly/Monthly/One time switch, 3-step "how it works", check + "Back to Messages" when done. Checked at phone size; **a real Face ID join on the new page is still to do** (dry run) | demo |
| 14 | Limits per chat: recurring (weekly/monthly, refills up to the limit) or one-time (trip); chat picks its plan (`set_group_plan`) | Neena | ✅ live: Siya and Joey rejoined the new contract; Siya set "Roommates $10 a week". One-time (trip) not run live yet | demo |
| 15 | Trip tab: splits settle now or go on the tab until "settle up" (`settle_up`) | Neena | ✅ live: #2 Coffee went on the tab, 👍, "Settle up" settled it | demo |
| 16 | Leave a chat's Kitty (`leave_kitty` → operator `removeMember`) | Neena | 🟡 built; live test pending | demo |
| 17 | Agent answers "how much money do I have" with the real balance, not the limit (74f353a) | Neena | ✅ built, balances checked live (Siya $10, Joey $0); chat retest pending | demo |
| 18 | Only one bot per Messages account (pid lock, 9f8fa33). Five ran at once on Nov 18 and doubled replies / hit the RPC rate limit | Neena | ✅ | — |
| 19 | Kitty buys it (pay before): `buy_for_group` → checkout card → everyone 👍 → order → shares pulled to the card's owner | Neena | 🟡 built (7b10415), tested end to end in unit tests; runs on a **simulated** store until Crossmint production keys are set. Nov 19: card charges fixed to use a client key + Kitty-signed JWT (3dc2f73); save-card page `card.html` + `crossmint card` / `crossmint buy` CLI (ad4a918), live. Nov 19: production keys set, "Custom tokens" JWT auth with JWKS `https://kittyagent.vercel.app/api/jwks` (Crossmint never read the `/.well-known/` copy), Neena's card saved. ✅ **First real order Nov 19:** `crossmint buy --max 3` bought a $1 Gumroad wallpaper pack, $1.07 charged to Neena's card (run 3848b9cc, receipt emailed). Learned live: questions nest under `requiredAction.request`, stores ask forms (answered from CROSSMINT_BUYER_*), dropdowns want option ids, always pick guest over Link, cards need a one-time order-intent registration (now automatic), order intents need an Origin header. **To do:** a real order from the chat (needs Siya's bot restart with the new .env keys). Airbnb is a stretch: merchants that block agents end cleanly as "nothing was charged" | demo |
| 20 | New members' names: asked privately in the invite text before the Face ID link (never in the group); MEMBER_NAMES optional (#11) | Neena | ✅ built (26a176c), tested; needs a pull + restart of the bot on Siya's Mac | demo |
| 21 | ElevenLabs: Kitty phones a business to book (voice agent), gets the price, and the price becomes a split | Neena | ✅ Nov 20, simulator + real Claude agent + real phone: "book 3 canoes … Lakeside Canoe … (518) 817-3144, saturday 9am" → `call_to_book` → the Mac dialed Akash's phone through the paired iPhone (KITTY_CALL_BRIDGE) → he answered as the rental, quoted $250 → "🧾 #1 Lakeside Canoe Rentals $250, pay back Neena: Siya $83.33, Tristan $83.33" on the tab → 👍👍 → "settle up" → settled. Agent renamed "Kitty (booking calls)" with `total_price_usd`. No Twilio line: the upgraded account needs business KYC (EIN) to buy a number or call. Bridge caveat: Kitty hears the call through the laptop mic, so keep the room quiet; click the call page when the callee picks up. For the group chat: the bot's Mac needs BlackHole, Calls from iPhone, the call page on :5199, and KITTY_CALL_BRIDGE=1 + KITTY_CALL_PAGE_URL in .env | demo |
| 22 | Test money: text Kitty privately "add $20" ($20/request, $50/day from the bot's wallet); `pnpm --filter @gta/server fund <phone|address> <usd>` | Neena | ✅ built (eb507b5); fund CLI run live (Joey +$1) | demo |
| 24 | Add-money page: "Add $20 test money" button (`/api/test-money` on Vercel) sends test USDC on Arc from a separate faucet wallet `0xa293928ecD5a3a38f150ca165773d27a3114eC20` (funded $100 from the operator Nov 19); no per-account cap (removed Nov 19 at Neena's request; anyone with the page can tap again). Apple Pay steps back to a second button | Neena | ✅ live: tapped on a phone Nov 19, balance went up $20 on Arc. Live site retested Nov 19: $20 to a fresh account in 4.4s (0xd1c0…b6d5), money returned to the faucet. 7 unit tests (3420dc6) | demo |
| 23 | "Your kitties": every chat's limit, what's left, "resets in N days" on the Face ID page after sign-in (and a ?v=1 link), and in private texts | Neena | ✅ built (069e809), page checked with Joey's real data and deployed; needs Siya's bot restart for the links | demo |
| 25 | Subscriptions: `start_subscription` posts a 🔁 card, everyone 👍s once (first charge), then the server charges the same split weekly/monthly (`chargeSubscriptions` every 5 min; `SUBSCRIPTION_EVERY_MIN` for demos); `cancel_subscription` stops it | Neena | 🟡 built Nov 19, 8 unit tests; run with the real agent in the simulator (`/later 31`): card → 👍s → first charge → two monthly charges → cancel. Live run needs a bot restart | demo |
| 26 | Balance = what your kitties can take: `topUpBalances` tops each account up to the sum of its remaining caps (testnet: operator sends it, `AUTO_TOPUP_DAILY_USD`; real money: once-a-day Apple Pay link). Runs before subscription charges | Neena | 🟡 built Nov 19, 4 unit tests (across kitties, never takes out, cents + daily limit, remind mode). Live run needs a bot restart and operator balance | demo |
| 27 | Member cards: private save-card link per member (`card.html` member mode, "Send to Kitty" texts the card id back), buys charge the payer's own card (per-member Crossmint user); subscription start texts each participant Face ID / card / add-money links as needed | Neena | 🟡 built Nov 19, 4 unit tests. Live: set `BOT_IMESSAGE_ADDRESS`, deploy the card page, restart the bot; a real card save from a phone still to do | demo |
| 28 | QuickNode Streams (bounty): Stream on Arc Testnet (`block_with_receipts`, filter `apps/onboard/streams/filter.js`) → signed webhook `api/stream.ts` → Neon Postgres; dashboard history (`api/history.ts`) and the bot's watcher (`api/events.ts`, `JoinWatcher` feed mode, RPC fallback) read it; Receipt links on every money row | Neena | ✅ live Nov 20: Stream created in the QuickNode dashboard (batch 1, `X-Kitty-Secret` header for Check connection). A real Face ID join (test kitty, block 73163328) arrived HMAC-signed, landed in Neon, served by `/api/history` and `/api/events`; `JoinWatcher` in feed mode dispatched it with no RPC. Bot side needs `KITTY_EVENTS_URL` + `EVENTS_SECRET` on Siya's Mac | bounty |
| 12 | Neena's own messages: bot runs on her Apple ID, so it ignores her | Neena | ✅ the bot runs on its own Apple ID (`ubc2026.agent@gmail.com`) on Siya's Mac since Nov 19; members rejoining the new group. The bot on Neena's Mac is off | demo |

---

## Track A — Money & onchain

Owns: `contracts/`, `packages/wallet`, `packages/funding`, `apps/onboard`.

| Task | Status | Notes |
| --- | --- | --- |
| `GroupTreasury.sol` + Foundry tests | ✅ done | One deployment for every chat; per-chat members + limits; single-use join tickets; operator relays 👍 (`approveFor`) but can only lower limits / remove members; failed pulls become debts; weekly / monthly / **one-time (trip)** limits. 62 tests incl. fuzz "operator can't take more than the signed limit". **Arc testnet: `0xAF2b75eda3c50358Ce754b93c60F76F0871bE235`** (redeployed Nov 19 to add `netSettle`, block 73141404; everyone rejoins with Face ID, no one has yet as of Nov 20 3am). |
| Face ID onboarding page (`apps/onboard`) | ✅ done | **https://kittyagent.vercel.app** — Circle passkey wallet + one gasless batched op (approve USDC + `join`). Tested on a real iPhone. First join = 2 Face ID prompts, later visits = 1. No crypto words shown. Members see "spending cap", not "limit" (redesign Nov 19, see critical path #13). |
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
| `agent` — join + limit tools | ✅ done | `send_join_link`, limit changes (lower onchain, raise via Face ID link), `set_group_plan`, `leave_kitty`, `settle_up`. See critical path #3, #10, #14–16. |
| `agent` — no crypto words in chat | ✅ done | Members see "your Kitty account", "$50", "Face ID" — never wallet, USDC, transaction, Arc, onchain, gas, passkey. |
| `PurchaseAdapter` — **real** store checkout (Crossmint) | ✅ done | Crossmint Agent Checkouts REST; real (not mocked); 14 tests; `blocked` handled. Needs CROSSMINT creds to run live. |
| ✅ **Decided:** LLM + framework | ✅ done | **Claude + raw Anthropic SDK** (no web UI → dropped Vercel AI SDK), model **Sonnet 5**. Needs Anthropic API key (not the Claude subscription). |
| ✅ **Decided:** iMessage SDK | ✅ done | **imessage-kit** (local; reads `chat.db`). spectrum-ts local mode drops tapbacks and has no DMs — so it couldn't do 👍 approvals or onboarding DMs. Switched in 97109f4. |
| ✅ **Decided:** store + access method | ✅ done | **Crossmint** Agent Checkouts (universal catalog, buyer's own account via Browser Profiles). agent-browser kept as a swappable fallback behind `PurchaseAdapter`. |

## Shared — coordinate before touching

| Task | Status | Notes |
| --- | --- | --- |
| `packages/core` — interfaces | ✅ done | frozen contract between tracks; change together only |
| `apps/server` — wire real adapters | ✅ pay-after live on Arc; pay-before wired | Per-chat `ArcWalletAdapter`, wallets from `Joined`, live in a real group. Pay-before (`buy_for_group`, 7b10415) runs on a simulated store until Crossmint production keys are set. |
| Open PRs to sort out | 🟡 | #3 + #7 merged. Superseded by main, safe to close: #1 (workflow, c6d610d), #5 (wallet + 👍 rule, f8f014a/12487c5), #6 (`model.ts` no longer exists). #4 (imessage-kit 👍 resolver) superseded by the imessage-kit switch (97109f4), safe to close. |
| README for judges | ✅ updated Nov 19 (de73739) | Architecture, Arc + Circle usage, contract address, run steps. Final pass before submission. |
| **Decide:** project name | 🟡 working name | **Kitty**, page at `kittyagent.vercel.app`. Passkeys are tied to the domain, so pick the final domain before real users join. Package scope still `@gta/*`. |

## Ops notes

- **Secrets:** `contracts/.env` (gitignored): Arc RPC, operator key, treasury address, `CIRCLE_API_KEY`, `CIRCLE_CLIENT_KEY`. Vercel project `kittyagent` holds `CIRCLE_API_KEY` (secret), `VITE_CLIENT_KEY`, `VITE_TREASURY_ADDRESS`. ⚠️ Rotate the Circle API key (it was exposed in a session log).
- **Operator wallet** `0xDEbAA02AAB62BDc01dddd5830D3a0D613C80842f` pays gas and $5 welcome balances; ~$105.68 test USDC on Nov 19 (each join costs $5; "add $20" also draws from it). Top up at faucet.circle.com (Arc Testnet).
- **Vercel deploys** run from a copy of `apps/onboard` outside git, because the git commit email isn't on the Vercel team. Add it to the team (or connect the repo) to deploy from git.

**Legend:** ✅ done · 🟡 in progress · ⬜ todo · 🔲 decision needed
