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

## Not in this demo (yet)

- **Real iMessage**: `pnpm --filter @gta/server dev` — needs a Mac + Full Disk Access + `ALLOWED_CHAT_IDS`
  (send `#treasury` in the chat to find its id). See `apps/server/.env.example`.
- **Pay-before (buy something via Crossmint)**: the `PurchaseAdapter` is built but not yet wired into the runtime.
- **Onchain settlement**: the Arc `GroupTreasury` contract is Track A (separate).
