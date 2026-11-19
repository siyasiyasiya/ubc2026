# Demo: the pay-after (dinner) flow

The minimal end-to-end demo, no Mac / no chain / no Crossmint. It runs the **real agent,
runtime, state machine, and wallet** with a **simulated group chat** in your terminal:

> someone paid for dinner → Claude reads the chat → posts a split card → everyone 👍 →
> each person's share is pulled within their limit → **✅ Settled**.

## What's real vs. simulated

| Real | Simulated |
| --- | --- |
| Claude agent (`runTurn`) deciding + proposing the split | The iMessage transport (prints to your terminal) |
| Claude vision reading a receipt photo (`/photo`) | The wallet — `InMemoryWalletAdapter` (no chain) |
| The core state machine + settlement logic | 👍 reactions (you type `/like`) |

The only external call is **Claude**, so you need an Anthropic API key.

## Setup (~2 min)

1. **Get an Anthropic API key** at [console.anthropic.com](https://console.anthropic.com) → API keys.
   ~$5 of credits is plenty. A Claude **Pro/Max subscription does NOT work** — it must be an API key.
2. Create the env file and paste your key:
   ```bash
   cp apps/server/.env.example apps/server/.env
   # edit apps/server/.env → ANTHROPIC_API_KEY=sk-ant-...
   ```
3. Install + build core once:
   ```bash
   pnpm install && pnpm --filter @gta/core build
   ```

## Run it

```bash
pnpm --filter @gta/server sim
```
Members are `neena`, `siya`, `tristan`. Type `name: message`. (If you see a `⚠️ No ANTHROPIC_API_KEY`
warning, fix step 2 — the first message will otherwise 401.)

## Happy-path script

```
neena: dinner at uchi friday, I paid $90, split with siya and tristan
```
→ Claude proposes an even 3-way split ($30 each) and posts the approval card as request **#1**.
The payer (neena) is auto-approved; the other two just need to 👍:
```
/like siya 1
/like tristan 1
```
→ each $30 share is pulled to the payer → **`✅ Settled #1`**.

Type `/state` anytime to inspect the group record.

## Safety variant — "the agent can't break the rules"

This shows the per-member limit the onchain contract will enforce, even in-memory. Set a low limit,
restart, and run the same script:
```bash
# in apps/server/.env
DEFAULT_LIMIT_USD=20
```
A $30 share now exceeds the $20 weekly limit → the pull fails and you get
**`⚠️ Partly settled`** with that member's recorded debt — the agent could not pull past the limit.

## Optional — read a real receipt (`/photo`)

```
/photo neena ./receipt.jpg
```
Claude vision extracts the total/tax/tip. Requires **macOS** (`sips` for image conversion) + the API
key. Great as a "it reads a real receipt" beat, but for a fast, deterministic demo prefer stating the
amount in text (as above).

## Pre-demo checklist

- [ ] `apps/server/.env` has a working `ANTHROPIC_API_KEY`
- [ ] `pnpm --filter @gta/core build` ran (so `@gta/*` imports resolve)
- [ ] `pnpm --filter @gta/server sim` starts and prints "Simulator ready"
- [ ] Happy path reaches `✅ Settled #1`
- [ ] (optional) over-limit variant reaches `⚠️ Partly settled`

## Real iMessage demo (on a Mac)

The chat layer runs on **imessage-kit** (it reads the Mac's Messages database), so native **👍 tapbacks** and **DMs** both work for real.

**Prereqs**
- A **Mac** signed into iMessage, with **Full Disk Access** granted to your terminal (System Settings → Privacy & Security → Full Disk Access).
- `apps/server/.env` with `ANTHROPIC_API_KEY`, plus:
  - `SELF_HANDLE=` the bot Apple ID's phone/email (so it attributes its own messages correctly)
  - `MEMBER_NAMES=+15550000001=Neena,+15550000002=Siya` (map handles → names)
  - Wallet: leave `TREASURY_ADDRESS` / `OPERATOR_PRIVATE_KEY` empty for the **in-memory** wallet, or set them to settle on **Arc**.

**Run**
1. `pnpm --filter @gta/server dev`
2. Send a message containing `#treasury` in your test group → the server logs that chat's id → add it to `ALLOWED_CHAT_IDS` in `.env` and restart.
3. In the group: `dinner at Uchi, I paid $90, split with Siya and Tristan` → the agent posts the split card → members **tap 👍** on it → `✅ Settled`.

**Onboarding (optional — for the Arc / real-wallet demo)**
- A member replies `in` → the agent DMs them the Face ID link (DMs work on imessage-kit).
- Or send it manually: `pnpm --filter @gta/server invite <chatId> <handle> [name]` (needs `INVITE_SECRET` set).

**Confirm tapbacks reach the bot:** `pnpm --filter @gta/imessage exec tsx scripts/watch-reactions.ts` — prints each incoming reaction and how the adapter maps it (read-only; never sends).

## Not yet wired

- **Pay-before (the agent *buys* something via Crossmint)** — the `PurchaseAdapter` is built and tested but not yet driven by the runtime. This is the biggest remaining feature.
