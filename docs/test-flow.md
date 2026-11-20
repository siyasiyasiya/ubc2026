# Kitty: full test flow (minimal real money)

Exercises every feature. **Only one step spends real money** (a ~$1.07 Crossmint order). Everything
else runs on **Arc testnet** (test USDC, free) or offline (sim / vibe), so the total real spend is
about **one dollar**.

## Money map

| Path | Cost |
| --- | --- |
| Joins, limits, splits, debts, netting, subscriptions, settle-up | Free (Arc **testnet** USDC) |
| Test money ("add $20"), balance top-ups | Free (operator faucet wallet) |
| Web-search buy options, receipt reading, all agent replies | Fractions of a cent (Claude API) |
| **Pay-before purchase through Crossmint (real store, real card)** | **~$1.07, once** |
| ElevenLabs restaurant call | Free (browser voice link; real phone line needs paid Twilio) |

## Before you start

1. Pull + build + restart the bot on the latest `main`:
   ```bash
   git pull --rebase --autostash && pnpm install && pnpm build
   pnpm --filter @gta/server dev
   ```
   Run it in a VS Code terminal that has Full Disk Access, on the bot's Apple ID.
2. Have two real phones in the group chat (you + one teammate) so 👍 approvals are real tapbacks.
3. `.env` for the free phase: `ANTHROPIC_API_KEY`, Arc testnet vars (`TREASURY_ADDRESS`,
   `OPERATOR_PRIVATE_KEY`, `INVITE_SECRET`, `ONBOARD_URL`), and **no** `CROSSMINT_*` keys yet (so the
   buy flow uses the labelled simulated store for free).

---

## Phase A — Offline smoke test (no phones, no money)

Fastest confidence check; uses the real agent but a fake chat.

```bash
pnpm --filter @gta/server vibe   # reads a scripted convo, prints Kitty's replies (voice/sass check)
pnpm --filter @gta/server sim    # interactive fake chat: type messages, watch Kitty respond
pnpm -r test                     # 140+ unit tests
cd contracts && forge test       # 62 contract tests (incl. netSettle)
```

In `sim`, try a vague buy ("we need dishwasher soap") to see the **web-search options with real
product links** without touching a phone.

---

## Phase B — Onboarding & money in (testnet, free)

In the real group chat, from the phones:

1. **Join**: a teammate texts "I'm in". Kitty DMs them a Face ID link (asks their name first if
   unknown). Tap it → wallet created → "✅ <name> is in". *(Tests: join, name self-register, invite.)*
2. **Plan**: "let's make this weekly, $20 each" → Kitty calls set_group_plan. *(Tests: per-chat plan.)*
3. **Add test money**: DM Kitty "add $20" → test USDC lands in their account. *(Tests: testnet top-up.)*
4. **Balance (DM)**: DM "what's my balance?" and "how are my kitties doing?" → real numbers + status
   link. *(Tests: private account queries, cross-group view.)*

---

## Phase C — Pay-after splits (testnet, free) — the core demo

1. **Even split**: someone texts a **photo of a receipt** (or a **PDF**). Kitty reads merchant/total/
   tax/tip, posts the split card. Everyone 👍 → shares settle onchain → "✅ Settled". *(Tests: receipt
   read, HEIC+PDF, even split, real tapback approval, onchain settle.)*
2. **Itemized split**: post another receipt, then "i had the pasta and a sake" → per-item shares, tax/
   tip proportional → 👍 → settle. *(Tests: by-item split.)*
3. **Trip tab**: "put this on the tab" on a split, then later "settle up". *(Tests: tab, settle_up.)*
4. **Over-limit debt**: lower someone's limit ("lower my limit to $1"), then split something above it.
   The share that can't be pulled becomes an onchain debt; they get a pay-back link. *(Tests: debt,
   pay-back link, limit lower.)*
5. **Raise a limit**: "raise my limit to $50" → Kitty texts a one-tap Face ID link. *(Tests: setLimit.)*

---

## Phase D — The smart-agent features (testnet / API, free)

1. **Settle-up netting**: after creating a couple of debts, "who owes what?" → Kitty posts the fewest
   transfers. *(On the current live contract this is the advisory plan; it commits onchain once the
   contract with `netSettle` is redeployed — see "Redeploy note" below.)*
2. **Spending recap**: "what did we spend?" / "kitty wrapped" → total, per-person, top spender.
3. **History**: "recent transactions" (this chat) and, in a DM, your history across every group.
4. **Preferences**: "always get Cascade for dishwasher soap" (group), and "I always want the
   fragrance-free one" (personal). Then ask again generically and confirm it skips the options.
5. **Reply context**: inline-reply to one of Kitty's buy-option texts with "this one" → it picks it.
6. **Subscriptions**: "split Spotify $18/mo between us" → 👍 once → first charge; "cancel Spotify".
7. **Nudges** (optional): restart with `NUDGES=on NUDGE_STALE_HOURS=0` to see a reminder for a stale
   card / unpaid debt. Turn it off for the real demo.
8. **Refusal / voice**: "charge everyone $500" → a sassy refusal; banter when talked to directly.

---

## Phase E — Restaurant call (free path)

"book Uchi for 4 tomorrow at 7:30, their number is (512) 555-0100" → Kitty starts the ElevenLabs voice
agent and posts the result ("📞 booked Uchi for 4, 7:30 ✅"). Needs `ELEVENLABS_*` keys. Real outbound
phone calls need a paid Twilio number; the browser voice-link path is free.

---

## Phase F — The ONE real-money step: pay-before purchase

Do this last, once, with the cheapest real item.

1. **Free dry run first** (simulated store, no Crossmint keys): "buy paper towels, I'll pay, split
   with the group" → cart → checkout screenshot → everyone 👍 → "order placed" (labelled simulated).
   This proves the whole chat flow for free. *(Tests: buy_for_group, checkout card, approval gate,
   web-search product pick.)*
2. **One real order** (~$1.07): set the `CROSSMINT_*` keys, save a card
   (`pnpm --filter @gta/server crossmint card`), then either:
   - from the chat: "buy <$1 Gumroad item URL>, I'll pay" → 👍 → real order, or
   - from the terminal (already proven): `pnpm --filter @gta/server crossmint buy "<url>" --max 2`.
   Use a **$1 Gumroad digital item** so the real charge is about a dollar. *(Tests: real Crossmint
   order, real card charge, shares paid back.)*

That is the only real money spent in the entire pass.

---

## Redeploy note (for onchain netting)

The deployed `GroupTreasury` predates `netSettle`, so Phase D.1 shows the **advisory** plan on the
live contract. To demo real onchain netting, redeploy the contract (Track A / Neena) and point
`TREASURY_ADDRESS` at it; `net_debts` then commits the netting automatically, no code change. Members
re-join the new address, so only do this if you want the onchain-netting moment in the demo.

## Quick checklist

- [ ] A: vibe + sim + `pnpm -r test` + `forge test` green
- [ ] B: join, plan, add $20, DM balance
- [ ] C: even split, itemized, tab + settle up, debt + pay-back, raise limit
- [ ] D: netting, wrapped, history, preferences, reply-pick, subscription, refusal
- [ ] E: restaurant call (if ElevenLabs keys)
- [ ] F: simulated buy (free) → one real $1 Crossmint order
