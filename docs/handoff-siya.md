# Handoff to Siya's Claude (Fri Nov 20, ~5am CST, deadline 12:00 PM CST)

Written by Neena's Claude session. Read this top to bottom, then do **"ASAP before the demo"** in order. The bot runs on Siya's Mac (Messages signed into Kitty's own Apple ID, `ubc2026.agent@gmail.com`), so most of what's left is: pull, put the new keys in `.env`, set up the phone-call bridge, restart, and run each flow once from the real group chat.

**Secrets:** never paste keys into chat or commit them. Neena sends the values to Siya privately (AirDrop a text file, or a password manager). Each key below says where it goes; `apps/server/.env.example` has a placeholder line for every one.

---

## 1. What changed since Siya's last pull (newest first)

| Commit | What |
| --- | --- |
| `885c03f` | Docs for booking calls; the call page starts Kitty when the callee speaks **or** when you click it |
| `4f0f9da` | **Booking calls** (ElevenLabs): `call_restaurant` → `call_to_book`; the agent asks the total price; a booked call with a price becomes a split on the trip tab. Plus the **Mac call bridge** (real phone calls with no paid line) |
| `28fe762` | `apps/onboard/call.html`: Kitty's incoming-call screen (ElevenLabs web SDK) |
| `5890f44` | Short `/k/<code>` links with a slim iMessage card |
| `6a52eae` | Add-money page hides the test-money button unless the link has `test=1` |
| `eb840ac`, `c1472f5`, `c9114f2`, `6474857` | **QuickNode Streams**: dashboard history and the bot's join watcher read a Stream instead of polling (live, verified Nov 20) |
| `82de87a` | GroupTreasury redeployed with `netSettle` (Siya's onchain netting); the bot resets links on a new contract |
| `9de4c8d`, `3e79a97` | Calls in the simulator; Kitty waits through "um"s |

## 2. The new features, explained

### Booking calls (ElevenLabs), the demo's "wow" moment
- In the group: **"kitty book 3 canoes for 2 hours at Lakeside Canoe Rentals, (518) 817-3144, saturday 9am, under neena"**.
- Kitty's `call_to_book` tool starts an **ElevenLabs voice agent** ("Kitty (booking calls)", id `agent_9401m7v381pmfb8rz7yzrvrrd03z`, already configured via the API). It introduces itself as an AI assistant for the group, books it, and **asks what the total comes to**. It never accepts a different time on its own.
- When the call ends the server reads ElevenLabs' analysis (`booking_confirmed`, `confirmed_time`, `alternative_offered`, `total_price_usd`). If it's booked with a price, the result goes back to the agent as an event, and Kitty posts the booking **and proposes the split** in one go: whoever it's under paid the business, everyone on the trip pays them back, on the trip's tab → 👍s → "settle up" settles on Arc.
- **Verified live Nov 20** (simulator + real Claude agent + real phone call to Akash): booked 3 canoes Sat 9am, $250 → "🧾 #1 Lakeside Canoe Rentals $250.00, Pay back Neena: Siya $83.33, Tristan $83.33" → 👍👍 → "settle up" → "✅ Settled … Siya → Neena $83.33 ✓".
- Code: `apps/server/src/booking-call.ts`, `GroupRuntime.callToBook` / `followCall` in `runtime.ts`, tool in `packages/agent/src/brain.ts`. Agent setup: `docs/elevenlabs-agent.md`.

### How the call is placed (and why it's a Mac bridge, not Twilio)
- **Twilio is a dead end for today.** We upgraded a Twilio account ($20), but new accounts can't buy a number **or place calls** until a business profile with an EIN is approved in Trust Hub. We don't have one. `ELEVENLABS_PHONE_NUMBER_ID` stays unset.
- **What we use: a real phone call from the bot's Mac** (`KITTY_CALL_BRIDGE=1`). `scripts/call-bridge/dial.sh` dials through the Mac's paired iPhone ("Calls from iPhone"), so the call comes from **that iPhone's number** (on Siya's Mac: Siya's number). It opens the call page in Chrome, which runs the ElevenLabs agent:
  - Kitty's voice → the **BlackHole 16ch** virtual device → set as the Mac's input → into the call.
  - The other person → the Mac's speakers (macOS always plays phone calls there) → Kitty listens through the **laptop mic**. So: **quiet room, no headphones.**
  - The page waits on "ringing… (click when they answer)": Kitty starts when it hears the callee or when someone **clicks the page / presses a key**. Click the moment they pick up.
- Fallback with no Mac setup: Kitty texts the business a link to the call page (`KITTY_CALL_PAGE_URL`), which rings in their browser and they tap Accept. Not a real phone call.

### Other new pieces
- **QuickNode Streams** (bounty): Arc events → signed webhook → Neon → dashboard history + the bot's join watcher. Live.
- **Short links** `/k/<code>` with a small iMessage card per link type.
- **netSettle** contract redeploy (Siya's netting, now onchain).

## 3. Set up booking calls on Siya's Mac (~20 min)

Do these on the Mac that runs the bot.

1. **Pull and install**
   ```bash
   git pull --rebase --autostash && npx -y pnpm@9.15.0 install && npx -y pnpm@9.15.0 build
   ```
2. **Audio tools** (BlackHole asks for the Mac password; the driver needs the audio service restarted):
   ```bash
   brew install --cask blackhole-16ch
   ```
   ```bash
   brew install switchaudio-osx
   ```
   ```bash
   sudo killall coreaudiod
   ```
   Check: `SwitchAudioSource -a` lists **BlackHole 16ch**.
3. **Calls from iPhone** (the iPhone signed into the same Apple ID as **FaceTime** on this Mac; Messages can stay on Kitty's Apple ID, FaceTime is separate):
   - iPhone: Settings → Apps → Phone → **Calls on Other Devices** → on, and turn on this Mac.
   - Mac: FaceTime → Settings → **Calls from iPhone** ✓.
   - Test: `open tel://+1<a teammate>` should ring them from the Mac.
4. **Chrome** must be installed (the script opens Google Chrome). The first call asks for **mic access on localhost:5199**: click Allow.
5. **Run the call page** in its own terminal and leave it running:
   ```bash
   cd apps/onboard && ./node_modules/.bin/vite --port 5199 --strictPort
   ```
6. **`apps/server/.env`** (values from Neena, privately):
   ```
   ELEVENLABS_API_KEY=<from Neena>
   ELEVENLABS_AGENT_ID=agent_9401m7v381pmfb8rz7yzrvrrd03z
   KITTY_CALL_BRIDGE=1
   KITTY_CALL_PAGE_URL=http://localhost:5199/call.html
   ```
   Leave `ELEVENLABS_PHONE_NUMBER_ID` empty.
7. **Restart the bot.** The log should say `calls: ElevenLabs voice agent, real phone calls from this Mac (KITTY_CALL_BRIDGE)`.
8. **Test first in the simulator** (same `.env`, no iMessage):
   ```bash
   cd apps/server && npx tsx --env-file=.env src/sim.ts
   ```
   then type `neena: canoe trip saturday, all 3 of us in. kitty book 3 canoes for 2 hours at Lakeside Canoe Rentals, (518) 817-3144, saturday 9am, under neena` (518-817-3144 is Akash). Answer as the rental, quote "$250". Kitty may first ask for the trip plan ("one time trip, 200 each"). Then `/like siya 1`, `/like tristan 1`, `neena: settle up`.
9. **Then from the real group chat**, same message.
10. After the demo, put the Mac's audio back: `scripts/call-bridge/dial.sh --restore`.

**If Kitty stays on "ringing…"**: click the Kitty page. **If the callee hears nothing**: check the macOS call bar isn't muted, and that the Mac's input is BlackHole 16ch (`SwitchAudioSource -c -t input`). **If Kitty hears garbage**: the room is too loud, or headphones are connected (the script refuses to dial with headphones listed).

## 4. Agentic checkout online (Crossmint), can we run it?

**Yes, it works, and it was run for real on Nov 19 from the terminal:** `crossmint buy --max 3` bought a $1 Gumroad item through **Crossmint Agent Checkouts** and charged $1.07 to Neena's card (receipt emailed). The chat flow is built and unit-tested: `buy_for_group` → Crossmint drives the store's checkout up to payment (real total) → checkout card in the chat → everyone 👍 → order placed on the payer's card → shares pulled to the payer on Arc.

**What's missing: a run from the real group chat**, because the bot on Siya's Mac doesn't have the Crossmint keys yet. To do it:
1. Put these in Siya's `apps/server/.env` (values from Neena, privately; the private key is multi-line, keep the quotes):
   ```
   CROSSMINT_API_KEY=sk_production_…
   CROSSMINT_CLIENT_API_KEY=ck_production_…
   CROSSMINT_JWT_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----…"
   CROSSMINT_JWT_KID=…
   CROSSMINT_USER_ID=…
   CROSSMINT_PAYMENT_METHOD_ID=…        # Neena's saved card
   CROSSMINT_BUYER_EMAIL / _NAME / _ZIP / _COUNTRY
   BOT_IMESSAGE_ADDRESS=ubc2026.agent@gmail.com   # so members can text their own card back
   ```
2. Restart the bot; the log should no longer say "simulated store".
3. In the group: **"kitty buy <a cheap digital item URL> for us, split between neena siya tristan, neena's card"** with a hard cap. Use a $1-ish digital good (Gumroad worked). Everyone 👍 → order → "Settled".
4. Know the limits: real money on a real card. Physical goods and stores that block agents (Airbnb, most big retailers) end cleanly as "nothing was charged". **Airbnb is a stretch; don't demo it live.** If keys aren't set in time, the store is clearly labelled "(simulated)": say so on stage.
5. Members' own cards: Kitty texts a private save-card link (`kittyagent.vercel.app/card.html`); a real save from a phone hasn't been done yet.

## 5. Where everything stands

Working live: Face ID join and per-chat spending caps on Arc, 👍-approved splits settled onchain, trip tab + settle up, onchain netting (`netSettle`), test money / add money, the web dashboard, QuickNode Streams, **booking calls → split** (simulator with the real agent and a real call).

Built but needs **Siya's bot restart** on latest `main` (plus keys) to run live: booking calls from the group chat (#21), Crossmint buys from the chat (#19), new-member name asks (#20), "your kitties" links (#23), subscriptions (#25), auto top-up (#26), member cards (#27).

## 6. ASAP before the demo (in order)

1. **Siya: pull `main`, add the keys above to `.env`, restart the bot.** Check the startup log lines for calls and Crossmint.
2. **Booking call setup** (section 3), then one real run from the group chat with Akash as the rental.
3. **One real Crossmint buy from the chat** with a $1 item (section 4).
4. **Deploy the onboard site to Vercel production** if `kittyagent.vercel.app/call.html` 404s (it was only preview-deployed). Run `vercel --prod` from `apps/onboard` in the main checkout. Only needed for the link-call fallback.
5. **Dry run of `docs/demo-script.md` on real phones** (#8), timing each step. Step 5 is now the canoe call.
6. **Devpost text**: `docs/devpost.md` exists only on Neena's local `feat/onboard-ui` branch (unpushed) and still says calls go "through a Twilio number". Push it and update that line to: real calls from the Mac through the paired iPhone, Kitty gets the price, the price becomes a split.
7. Small open live checks: Joey's Face ID pay-back (#9), a real join on the redesigned Face ID page (#13), leaving a kitty (#16).
8. **After the hackathon: rotate** the ElevenLabs API key and the Twilio auth token (both were pasted in a chat).

## 7. Accounts and ids

| What | Value |
| --- | --- |
| ElevenLabs agent | `agent_9401m7v381pmfb8rz7yzrvrrd03z`, "Kitty (booking calls)", on the ElevenLabs account signed in as "Akash" |
| Test "business" phone | Akash, +1 518-817-3144 |
| GroupTreasury (Arc testnet) | `0xAF2b75eda3c50358Ce754b93c60F76F0871bE235` |
| Bot Apple ID | `ubc2026.agent@gmail.com` (Messages on Siya's Mac) |
| Web pages | `kittyagent.vercel.app` (Face ID, card.html, dashboard, `/k/` links) |
